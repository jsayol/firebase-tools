import * as path from "path";
import * as WebSocket from "ws";

// tslint:disable-next-line: no-var-requires
const pkg = require(path.resolve(__dirname, "..", "..", "package.json"));

export interface WebSocketDebuggerInitData {
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
}

interface LocalInitData {
  version: string;
}

interface Message {
  type: string;
  payload: any;
}

type RecvMessageType = "init" | "stop" | "error";
type SendMessageType =
  | "init"
  | "log"
  | "error"
  | "stdout"
  | "stderr"
  | "pid"
  | "emulator-port-taken";

function isValidInitData(
  initData: WebSocketDebuggerInitData
): initData is WebSocketDebuggerInitData {
  return (
    initData.client &&
    typeof initData.client.name === "string" &&
    typeof initData.client.version === "string" &&
    typeof initData.projectNumber === "string" &&
    !!initData.firebaseConfig &&
    !!initData.node &&
    typeof initData.node.installIfMissing === "boolean"
  );
}

export class WebSocketDebugger {
  private client: WebSocket;
  private stdoutWrite?: typeof process.stdout._write;
  private stderrWrite?: typeof process.stderr._write;
  private onStopCallback?: (...args: any[]) => any;

  private init: {
    promise: Promise<WebSocketDebuggerInitData>;
    resolve: (value?: WebSocketDebuggerInitData | PromiseLike<WebSocketDebuggerInitData>) => void;
    reject: (reason?: any) => void;
  };

  constructor(address: string) {
    this.client = new WebSocket(address);

    this.init = {} as any;
    this.init.promise = new Promise((resolve, reject) => {
      this.init.resolve = resolve;
      this.init.reject = reject;
    });

    this.client.on("open", async () => {
      const payload: LocalInitData = {
        version: pkg.version,
      };
      await this.sendMessage("init", payload);
    });

    this.client.on("message", async (data: string) => {
      let message: any;

      try {
        message = JSON.parse(data);
      } catch (err) {
        // Couldn't parse the message sent by the server... exTERMINATE!
        // (You have to read that last part with a Dalek voice or it won't be funny)
        await this.sendMessage("error", { error: err.message, data });
        this.terminate();
        return;
      }

      await this.processMessage(message);
    });

    this.stdoutCapture();
    this.stderrCapture();

    // Close the connection on an unhandled rejection
    process.on("unhandledRejection", async (reason) => {
      await this.sendMessage("error", { error: "unhandledRejection", data: reason });
      this.terminate();
    });
  }

  getInitData(): Promise<WebSocketDebuggerInitData> {
    return this.init.promise;
  }

  async getProjectConfig(): Promise<WebSocketDebuggerInitData["firebaseConfig"]> {
    return (await this.getInitData()).firebaseConfig;
  }

  async getProjectNumber(): Promise<string> {
    return (await this.getInitData()).projectNumber;
  }

  sendMessage(type: SendMessageType, payload?: any): Promise<void> {
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

      process.stdout._write = async (data, encoding, done) => {
        await this.init.promise;
        await this.sendMessage("stdout", { data, encoding });
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

      process.stderr._write = async (data, encoding, done) => {
        await this.init.promise;
        await this.sendMessage("stderr", { data, encoding });
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

  onStop(callback: (...args: any[]) => any): void {
    this.onStopCallback = callback;
  }

  private async stop(): Promise<void> {
    if (this.onStopCallback) {
      await this.onStopCallback();
    }
  }

  private async processMessage(message: { type: RecvMessageType; payload: any }): Promise<void> {
    const { type, payload } = message;

    switch (type) {
      case "init":
        if (isValidInitData(payload)) {
          this.init.resolve(payload);
        } else {
          this.terminate();
        }
        break;
      case "stop":
        this.stop();
        break;
      case "error":
        console.error(payload);
        break;
      default:
        await this.sendMessage("error", `Unknown message type "${type}"`);
        this.terminate();
    }
  }
}
