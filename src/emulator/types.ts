import { ChildProcess } from "child_process";
import { WebSocketDebuggerConfig } from "./websocketDebugger";
import { EmulatorRegistry } from "./registry";

export const enum Emulators {
  FUNCTIONS = "functions",
  FIRESTORE = "firestore",
  DATABASE = "database",
  HOSTING = "hosting",
}

// TODO: Is there a way we can just allow iteration over the enum?
export const ALL_EMULATORS = [
  Emulators.FUNCTIONS,
  Emulators.FIRESTORE,
  Emulators.DATABASE,
  Emulators.HOSTING,
];

export interface EmulatorInstance {
  /**
   * Called to begin the emulator process.
   *
   * Note: you should almost always call EmulatorRegistry.start() instead of this method.
   */
  start(wsConfig?: WebSocketDebuggerConfig): Promise<void>;

  /**
   * Called to tell the emulator to connect to other running emulators.
   * This must be called after start().
   */
  connect(): Promise<void>;

  /**
   * Called to stop the emulator process.
   *
   * Note: you should almost always call EmulatorRegistry.stop() instead of this method.
   */
  stop(): Promise<void>;

  /**
   * Get the information about the running instance needed by the registry;
   */
  getInfo(): EmulatorInfo;

  /**
   * Get the name of the corresponding service.
   */
  getName(): Emulators;
}

export interface EmulatorInfo {
  host: string;
  port: number;
}

export interface JavaEmulatorCommand {
  binary: string;
  args: string[];
}

export interface JavaEmulatorDetails {
  name: string;
  instance: ChildProcess | null;
  stdout: any | null;
  cacheDir: string;
  remoteUrl: string;
  expectedSize: number;
  expectedChecksum: string;
  localPath: string;
}

export interface Address {
  host: string;
  port: number;
}

export class EmulatorLog {
  static fromJSON(json: string): EmulatorLog {
    let parsedLog;
    let isNotJSON = false;
    try {
      parsedLog = JSON.parse(json);
    } catch (err) {
      isNotJSON = true;
    }

    parsedLog = parsedLog || {};

    if (
      isNotJSON ||
      parsedLog.level === undefined ||
      parsedLog.type === undefined ||
      parsedLog.text === undefined
    ) {
      parsedLog = {
        level: "USER",
        text: json,
      };
    }

    return new EmulatorLog(
      parsedLog.level,
      parsedLog.type,
      parsedLog.text,
      parsedLog.data,
      parsedLog.timestamp
    );
  }

  static fromObject(obj: { [k: string]: any }): EmulatorLog {
    return new EmulatorLog(obj.level, obj.type, obj.text, obj.data, obj.timestamp);
  }

  constructor(
    public level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" | "SYSTEM" | "USER",
    public type: string,
    public text: string,
    public data?: any,
    public timestamp?: string
  ) {
    this.timestamp = this.timestamp || new Date().toString();
    this.data = this.data || {};
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  toJSON(): any {
    return {
      timestamp: this.timestamp,
      level: this.level,
      text: this.text,
      data: this.data,
      type: this.type,
    };
  }

  get date(): Date {
    if (!this.timestamp) {
      return new Date(0);
    }
    return new Date(this.timestamp);
  }

  log(): void {
    process.stdout.write(`${this.toString()}\n`);

    const wsDebugger = EmulatorRegistry.getWebSocketDebugger();
    if (wsDebugger) {
      wsDebugger.sendMessage("log", this);
    }
  }

  send(): void {
    if (!process.send) {
      throw new Error("Can't process.send() from a non-child process.");
    }
    process.send({ type: "log", log: this.toJSON() });
  }
}
