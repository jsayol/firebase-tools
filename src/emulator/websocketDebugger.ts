import * as WebSocket from "ws";
import * as pkg from "../../package.json";

export interface WebSocketDebuggerInitData {
  version: string;
  projectPath: string;
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

type SendMessageType = "init" | "log" | "error" | "stdout" | "stderr";
type RecvMessageType = "init" | "error";

function isValidInitData(
  initData: WebSocketDebuggerInitData
): initData is WebSocketDebuggerInitData {
  return (
    typeof initData.version === "string" &&
    typeof initData.projectPath === "string" &&
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

    this.client.on("open", () => {
      const payload: LocalInitData = {
        version: pkg.version,
      };
      this.sendMessage("init", payload);
    });

    this.client.on("message", (data: string) => {
      let message: any;

      try {
        message = JSON.parse(data);
      } catch (err) {
        // Couldn't parse the message sent by the server... exTERMINATE!
        // (You have to read that last part with a Dalek voice or it won't be funny)
        this.sendMessage("error", { error: err.message, data });
        this.terminate();
        return;
      }

      this.processMessage(message);
    });

    this.stdoutCapture();
    this.stderrCapture();
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

  sendMessage(type: SendMessageType, payload?: any): void {
    const message: Message = { type, payload };
    try {
      this.client.send(JSON.stringify(message));
    } catch (err) {
      this.terminate();
    }
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
        this.sendMessage("stdout", { data, encoding });
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
        this.sendMessage("stderr", { data, encoding });
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

  private processMessage(message: { type: RecvMessageType; payload: any }): void {
    const { type, payload } = message;

    switch (type) {
      case "init":
        if (isValidInitData(payload)) {
          this.init.resolve(payload);
        } else {
          this.terminate();
        }
        break;
      case "error":
        console.error(payload);
        break;
      default:
        this.sendMessage("error", `Unknown message type "${type}"`);
        this.terminate();
    }
  }
}
