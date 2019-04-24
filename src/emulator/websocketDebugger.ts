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
      this.processMessage(data);
    });
  }

  async getProjectConfig(): Promise<WebSocketDebuggerInitData["firebaseConfig"]> {
    return (await this.init.promise).firebaseConfig;
  }

  async getProjectNumber(): Promise<string> {
    return (await this.init.promise).projectNumber;
  }

  sendMessage(type: string, payload?: any): void {
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

  private processMessage(data: string): void {
    let message: Message;

    try {
      message = JSON.parse(data);
    } catch (err) {
      this.sendMessage("error", err.message);
      this.terminate();
      return;
    }

    const { type, payload } = message;

    switch (type) {
      case "init":
        if (isValidInitData(payload)) {
          this.init.resolve(payload);
        } else {
          this.terminate();
        }
      default:
        this.sendMessage("error", `Unknown message type "${message.type}"`);
        this.terminate();
    }
  }
}
