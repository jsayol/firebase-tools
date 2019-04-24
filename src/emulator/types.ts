/* tslint:disable:no-console */
import { ChildProcess } from "child_process";
import { WebSocketDebuggerInitData } from "./websocketDebugger";
import { EmulatorRegistry } from "./registry";

export const enum Emulators {
  FUNCTIONS = "functions",
  FIRESTORE = "firestore",
  DATABASE = "database",
  HOSTING = "hosting",
}

export interface EmulatorInstance {
  start(wsInitData?: WebSocketDebuggerInitData): Promise<void>; // Called to begin emulator process
  connect(): Promise<void>; // Called once all sibling emulators are start()'d
  stop(): Promise<void>; // Called to kill emulator process
}

export interface EmulatorInfo {
  instance: EmulatorInstance;
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
    try {
      parsedLog = JSON.parse(json);
    } catch (err) {
      parsedLog = {
        level: "ERROR",
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
}
