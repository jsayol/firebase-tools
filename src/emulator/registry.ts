import * as clc from "cli-color";

import { ALL_EMULATORS, EmulatorInstance, Emulators } from "./types";
import * as FirebaseError from "../error";
import * as utils from "../utils";
import { WebSocketDebugger, WebSocketDebuggerConfig } from "./websocketDebugger";

/**
 * Static registry for running emulators to discover each other.
 *
 * Note that this is global mutable state, but the state can only be modified
 * through the start() and stop() methods which ensures correctness.
 */
export class EmulatorRegistry {
  static async start(instance: EmulatorInstance): Promise<void> {
    if (this.isRunning(instance.getName())) {
      throw new FirebaseError(`Emulator ${instance.getName()} is already running!`, {});
    }

    const wsDebugger = this.getWebSocketDebugger();
    let wsConfig: WebSocketDebuggerConfig | undefined;
    if (wsDebugger) {
      wsConfig = await wsDebugger.getConfig();
    }

    await instance.start(wsConfig);
    this.set(instance.getName(), instance);

    const info = instance.getInfo();
    utils.logLabeledSuccess(
      instance.getName(),
      `Emulator started at ${clc.bold.underline(`http://${info.host}:${info.port}`)}`
    );
  }

  static async stop(name: Emulators): Promise<void> {
    const instance = this.get(name);
    if (!instance) {
      return;
    }

    await instance.stop();
    this.clear(instance.getName());
  }

  static async stopAll(): Promise<void> {
    for (const name of this.listRunning()) {
      await this.stop(name);
    }
  }

  static isRunning(emulator: Emulators): boolean {
    const instance = this.INSTANCES.get(emulator);
    return instance !== undefined;
  }

  static listRunning(): Emulators[] {
    return ALL_EMULATORS.filter((name) => this.isRunning(name));
  }

  static get(emulator: Emulators): EmulatorInstance | undefined {
    return this.INSTANCES.get(emulator);
  }

  static getPort(emulator: Emulators): number | undefined {
    const instance = this.INSTANCES.get(emulator);
    if (!instance) {
      return undefined;
    }

    return instance.getInfo().port;
  }

  // TODO(jsayol): these methods should probably go somewhere else
  static setWebSocketDebugger(wsDebugger: WebSocketDebugger): void {
    EmulatorRegistry.WS_DEBUGGER = wsDebugger;
  }

  static getWebSocketDebugger(): WebSocketDebugger | void {
    return EmulatorRegistry.WS_DEBUGGER;
  }

  static hasWebSocketDebugger(): boolean {
    return EmulatorRegistry.WS_DEBUGGER !== undefined;
  }

  private static INSTANCES: Map<Emulators, EmulatorInstance> = new Map();

  private static WS_DEBUGGER?: WebSocketDebugger;

  private static set(emulator: Emulators, instance: EmulatorInstance): void {
    this.INSTANCES.set(emulator, instance);
  }

  private static clear(emulator: Emulators): void {
    this.INSTANCES.delete(emulator);
  }
}