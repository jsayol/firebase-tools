import * as path from "path";
import * as WebSocket from "ws";
import { EventEmitter } from "events";

import * as utils from "../utils";

// tslint:disable-next-line: no-var-requires
const pkg = require(path.resolve(__dirname, "..", "..", "package.json"));

export interface WebSocketDebuggerConfig {
  client: {
    name: string;
    version: string;
  };
  firebaseConfig: { [k: string]: any };
  projectNumber: string;
  node: {
    useVersion?: string; // major version number
    installIfMissing: boolean;
  };
  functionsDebug?: boolean;
}

interface LocalConfig {
  version: string;
}

interface Message {
  type: string;
  payload: any;
}

type RecvMessageType = "init" | "stop" | "error" | "web-config" | "set-debugging-state";
type SendMessageType =
  | "init"
  | "log"
  | "error"
  | "stdout"
  | "stderr"
  | "emulator-pid"
  | "emulator-port-taken"
  | "get-web-config"
  | "functions"
  | "debug-function";

function isValidConfig(config: WebSocketDebuggerConfig): config is WebSocketDebuggerConfig {
  return (
    config.client &&
    typeof config.client.name === "string" &&
    typeof config.client.version === "string" &&
    typeof config.projectNumber === "string" &&
    !!config.firebaseConfig &&
    !!config.node &&
    typeof config.node.installIfMissing === "boolean"
  );
}

export class WebSocketDebugger extends EventEmitter {
  private client: WebSocket;
  private stdoutWrite?: typeof process.stdout._write;
  private stderrWrite?: typeof process.stderr._write;
  private webAppConfig?: { [k: string]: any };
  private config?: WebSocketDebuggerConfig;

  private init: {
    promise: Promise<WebSocketDebuggerConfig>;
    resolve: () => void;
    reject: (reason?: any) => void;
  };

  private buffered: { stdout: string; stderr: string } = {
    stdout: "",
    stderr: "",
  };

  constructor(address: string) {
    super();
    this.client = new WebSocket(address);

    this.init = {} as any;
    this.init.promise = new Promise((resolve, reject) => {
      this.init.resolve = resolve;
      this.init.reject = reject;
    });

    this.client.on("open", async () => {
      const payload: LocalConfig = {
        version: pkg.version,
      };
      await this.sendMessagePromise("init", payload);
    });

    this.client.on("message", async (data: string) => {
      let message: any;

      try {
        message = JSON.parse(data);
      } catch (err) {
        // Couldn't parse the message sent by the server... exTERMINATE!
        // (You have to read that last part with a Dalek voice or it won't be funny)
        await this.sendMessagePromise("error", { error: err.message, data });
        this.terminate();
        return;
      }

      await this.processMessage(message);
    });

    this.stdoutCapture();
    this.stderrCapture();

    // Close the connection on an unhandled rejection
    process.on("unhandledRejection", async (reason) => {
      await this.sendMessagePromise("error", { error: "unhandledRejection", data: reason });
      this.terminate();
    });
  }

  async getConfig(): Promise<WebSocketDebuggerConfig> {
    await this.init.promise;
    return this.config!;
  }

  async getWebAppConfig(): Promise<{ [k: string]: any }> {
    if (this.webAppConfig) {
      return this.webAppConfig;
    }

    return new Promise(async (resolve, reject) => {
      this.once("error", reject);
      this.once("web-config", (config) => {
        resolve(config);
        this.removeListener("error", reject);
      });
      try {
        await this.sendMessagePromise("get-web-config");
      } catch (err) {
        reject(err);
      }
    });
  }

  sendMessage(type: SendMessageType, payload?: any): void {
    const message: Message = { type, payload };
    this.client.send(JSON.stringify(message), (err?: any) => {
      if (err) {
        this.terminate();
      }
    });
  }

  /**
   * Like sendMessage() but returns a promise that resolves when the message
   * has been sent successfully, or rejects if sending failed.
   */
  sendMessagePromise(type: SendMessageType, payload?: any): Promise<void> {
    return new Promise((resolve) => {
      const message: Message = { type, payload };
      try {
        this.client.send(JSON.stringify(message), (err?: any) => {
          resolve();
          if (err) {
            this.terminate();
          }
        });
      } catch (err) {
        resolve();
        this.terminate();
      }
    });
  }

  terminate(): void {
    this.client.terminate();
    this.init.reject();
    // TODO(jsayol): notify somewhere?
  }

  stdoutCapture(silent = true): void {
    if (!this.stdoutWrite) {
      this.stdoutWrite = process.stdout._write;

      process.stdout._write = (chunk, encoding, done) => {
        this.processOutput("stdout", chunk);
        if (silent) {
          done();
        } else {
          this.stdoutWrite!.apply(process.stdout, arguments as any);
        }
      };
    }
  }

  stderrCapture(silent = true): void {
    if (!this.stderrWrite) {
      this.stderrWrite = process.stderr._write;

      process.stderr._write = (chunk, encoding, done) => {
        this.processOutput("stderr", chunk);
        if (silent) {
          done();
        } else {
          this.stderrWrite!.apply(process.stderr, arguments as any);
        }
      };
    }
  }

  stdoutRelease(): void {
    if (this.stdoutWrite) {
      process.stdout._write = this.stdoutWrite;
      this.stdoutWrite = undefined;
    }
  }

  stderrRelease(): void {
    if (this.stderrWrite) {
      process.stderr._write = this.stderrWrite;
      this.stderrWrite = undefined;
    }
  }

  private processOutput(from: "stdout" | "stderr", chunk: string): void {
    this.buffered[from] += chunk;
    let newlineIndex = this.buffered[from].indexOf("\n");

    while (newlineIndex >= 0) {
      // `line` includes a newline at the end
      const line = this.buffered[from].slice(0, newlineIndex + 1);
      this.sendMessage(from, line);
      this.buffered[from] = this.buffered[from].slice(newlineIndex + 1);
      newlineIndex = this.buffered[from].indexOf("\n");
    }
  }

  private async processMessage(message: { type: RecvMessageType; payload: any }): Promise<void> {
    const { type, payload } = message;
    let isValidMessage = true;

    switch (type) {
      case "init":
        if (isValidConfig(payload)) {
          this.config = payload;
          this.init.resolve();
          if (this.config.functionsDebug) {
            utils.logLabeledBullet("functions", `Debugging enabled.`);
          }
        } else {
          this.terminate();
        }
        break;
      case "stop":
        // TODO: not sure if we need to do anything here.
        break;
      case "web-config":
        this.webAppConfig = payload;
        break;
      case "error":
        // tslint:disable-next-line: no-console
        console.error(payload);
        this.terminate();
        break;
      case "set-debugging-state":
        await this.init.promise;
        this.config!.functionsDebug = payload;
        utils.logLabeledBullet("functions", `Debugging ${payload ? "enabled" : "disabled"}.`);
        break;
      default:
        isValidMessage = false;
        await this.sendMessagePromise("error", `Unknown message type "${type}"`);
        this.terminate();
    }

    if (isValidMessage) {
      this.emit(type, payload);
    }
  }
}
