import { EmulatorInfo, EmulatorInstance, Emulators } from "./types";
import { WebSocketDebugger } from "./websocketDebugger";

export class EmulatorRegistry {
  static setInfo(emulator: Emulators, info: EmulatorInfo): void {
    this.INFO.set(emulator, info);
  }

  static clearInfo(emulator: Emulators): void {
    this.INFO.delete(emulator);
  }

  static isRunning(emulator: Emulators): boolean {
    const info = this.INFO.get(emulator);
    return info !== undefined;
  }

  static listRunning(): Emulators[] {
    const res: Emulators[] = [];
    for (const name of this.ALL) {
      if (this.isRunning(name)) {
        res.push(name);
      }
    }

    return res;
  }

  static getInstance(emulator: Emulators): EmulatorInstance | undefined {
    const info = this.INFO.get(emulator);
    if (!info) {
      return undefined;
    }

    return info.instance;
  }

  static getPort(emulator: Emulators): number {
    const info = this.INFO.get(emulator);
    if (!info) {
      return -1;
    }

    return info.port;
  }

  static setWebSocketDebugger(wsDebugger: WebSocketDebugger): void {
    EmulatorRegistry.WS_DEBUGGER = wsDebugger;
  }

  static getWebSocketDebugger(): WebSocketDebugger | void {
    return EmulatorRegistry.WS_DEBUGGER;
  }

  static hasWebSocketDebugger(): boolean {
    return EmulatorRegistry.WS_DEBUGGER !== undefined;
  }

  private static ALL = [Emulators.FUNCTIONS, Emulators.FIRESTORE, Emulators.DATABASE];

  private static INFO: Map<Emulators, EmulatorInfo> = new Map();

  private static WS_DEBUGGER?: WebSocketDebugger;
}
