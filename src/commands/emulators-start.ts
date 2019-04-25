"use strict";

import * as childProcess from "child_process";
import * as clc from "cli-color";
import * as pf from "portfinder";

import getProjectNumber = require("../getProjectNumber");
import * as Command from "../command";
import * as utils from "../utils";
import * as track from "../track";
import requireAuth = require("../requireAuth");
import requireConfig = require("../requireConfig");
import serveHosting = require("../serve/hosting");
import * as filterTargets from "../filterTargets";
import { EmulatorRegistry } from "../emulator/registry";
import { Address, EmulatorInfo, EmulatorInstance, Emulators } from "../emulator/types";
import { Constants } from "../emulator/constants";
import { FunctionsEmulator } from "../emulator/functionsEmulator";
import { DatabaseEmulator } from "../emulator/databaseEmulator";
import { FirestoreEmulator } from "../emulator/firestoreEmulator";
import { HostingEmulator } from "../emulator/hostingEmulator";
import { WebSocketDebugger, WebSocketDebuggerInitData } from "../emulator/websocketDebugger";

// TODO: This should come from the enum
const VALID_EMULATORS = ["database", "firestore", "functions", "hosting"];

async function checkPortOpen(port: number): Promise<boolean> {
  try {
    await pf.getPortPromise({ port, stopPort: port });
    return true;
  } catch (e) {
    return false;
  }
}

async function waitForPortClosed(port: number): Promise<void> {
  const interval = 250;
  const timeout = 30000;

  return new Promise(async (res, rej) => {
    let elapsed = 0;
    const intId = setInterval(async () => {
      const open = await checkPortOpen(port);
      if (!open) {
        // If the port is NOT open that means the emulator is running
        clearInterval(intId);
        res();
        return;
      }

      // After a timeout, stop waiting for the emulator.
      elapsed += interval;
      if (elapsed > timeout) {
        clearInterval(intId);

        // TODO(samstern): This should be FirebaseError
        rej(`TIMEOUT: Port ${port} was not active within ${timeout}ms`);
      }
    }, interval);
  });
}

async function startEmulator(
  name: Emulators,
  addr: Address,
  instance: EmulatorInstance,
  wsInitData?: WebSocketDebuggerInitData
): Promise<void> {
  // Log the command for analytics
  track("emulators:start", name);

  // TODO(samstern): This check should only occur when the host is localhost
  const portOpen = await checkPortOpen(addr.port);
  if (!portOpen) {
    utils.logWarning(`Port ${addr.port} is not open, could not start ${name} emulator.`);
    utils.logBullet(`To select a different port for the emulator, update your "firebase.json":
    {
      // ...
      "emulators": {
        "${name}": {
          "port": "${clc.yellow("PORT")}"
        }
      }
    }`);

    await cleanShutdown();
    return utils.reject(`Could not start ${name} emulator, port taken.`, {});
  }

  // Start the emulator, wait for it to grab its port, and then mark it as started
  // in the registry.
  await instance.start(wsInitData);
  await waitForPortClosed(addr.port);

  const info: EmulatorInfo = {
    host: addr.host,
    port: addr.port,
    instance,
  };
  EmulatorRegistry.setInfo(name, info);

  utils.logLabeledSuccess(name, `Emulator running at ${clc.bold(addr.host + ":" + addr.port)}.`);
}

function stopEmulator(name: Emulators): Promise<any> {
  if (!EmulatorRegistry.isRunning(name)) {
    return Promise.resolve();
  }

  const instance = EmulatorRegistry.getInstance(name);
  if (!instance) {
    return Promise.resolve();
  }

  return instance.stop();
}

async function cleanShutdown(): Promise<boolean> {
  utils.logBullet("Shutting down emulators.");

  for (const name of EmulatorRegistry.listRunning()) {
    utils.logBullet(`Stopping ${name} emulator`);
    await stopEmulator(name);
    EmulatorRegistry.clearInfo(name);
  }

  return true;
}

async function runScript(script: string): Promise<void> {
  utils.logBullet(`Running script: ${clc.bold(script)}`);

  const proc = childProcess.spawn(script, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });

  proc.stdout.on("data", (data) => {
    process.stdout.write(data.toString());
  });

  proc.stderr.on("data", (data) => {
    process.stderr.write(data.toString());
  });

  return new Promise((resolve, reject) => {
    proc.on("error", (err: any) => {
      utils.logWarning(`There was an error running the script: ${JSON.stringify(err)}`);
      reject();
    });

    // Due to the async nature of the node child_process library, sometimes
    // we can get the "exit" callback before all "data" has been read from
    // from the script's output streams. To make the logs look cleaner, we
    // add a short delay before resolving/rejecting this promise after an
    // exit.
    proc.once("exit", (code, signal) => {
      if (signal) {
        utils.logWarning(`Script exited with signal: ${signal}`);
        setTimeout(reject, 500);
      }

      if (code === 0) {
        utils.logSuccess(`Script exited successfully (code 0)`);
        setTimeout(resolve, 500);
      } else {
        utils.logWarning(`Script exited unsuccessfully (code ${code})`);
        setTimeout(resolve, 500);
      }
    });
  });
}

async function startAll(options: any, wsInitData?: WebSocketDebuggerInitData): Promise<void> {
  // Emulators config is specified in firebase.json as:
  // "emulators": {
  //   "firestore": {
  //     "host": "localhost",
  //     "port": "9005"
  //   },
  //   // ...
  // }
  //
  // The list of emulators to start is filtered two ways:
  // 1) The service must have a top-level entry in firebase.json
  // 2) If the --only flag is passed, then this list is the intersection
  //
  // Emulators must be started in this order:
  // 1) Functions --> No dependency
  // 2) Firestore / Database --> must be started before Functions (requires Functions port)
  // 3) Hosting --> must be started after Functions to enable redirects
  const targets: string[] = filterTargets(options, VALID_EMULATORS);
  options.targets = targets;

  utils.logBullet(`Starting emulators: ${JSON.stringify(targets)}`);

  if (targets.indexOf("functions") > -1) {
    const functionsAddr = Constants.getAddress(Emulators.FUNCTIONS, options);
    const functionsEmulator = new FunctionsEmulator(options, {
      host: functionsAddr.host,
      port: functionsAddr.port,
    });
    await startEmulator(Emulators.FUNCTIONS, functionsAddr, functionsEmulator, wsInitData);
  }

  if (targets.indexOf("firestore") > -1) {
    const firestoreAddr = Constants.getAddress(Emulators.FIRESTORE, options);
    const firestoreEmulator = new FirestoreEmulator({
      host: firestoreAddr.host,
      port: firestoreAddr.port,
    });
    await startEmulator(Emulators.FIRESTORE, firestoreAddr, firestoreEmulator);
  }

  if (targets.indexOf("database") > -1) {
    const databaseAddr = Constants.getAddress(Emulators.DATABASE, options);
    const databaseEmulator = new DatabaseEmulator({
      host: databaseAddr.host,
      port: databaseAddr.port,
    });
    await startEmulator(Emulators.DATABASE, databaseAddr, databaseEmulator);

    // TODO: When the database emulator is integrated with the Functions
    //       emulator, we will need to pass the port in and remove this warning
    utils.logWarning(
      `Note: the database emulator is not currently integrated with the functions emulator.`
    );
  }

  if (targets.indexOf("hosting") > -1) {
    const hostingAddr = Constants.getAddress(Emulators.HOSTING, options);
    const hostingEmulator = new HostingEmulator({
      host: hostingAddr.host,
      port: hostingAddr.port,
      options,
    });

    await startEmulator(Emulators.HOSTING, hostingAddr, hostingEmulator);
  }

  const running = EmulatorRegistry.listRunning();
  for (const name of running) {
    const instance = EmulatorRegistry.getInstance(name);
    if (instance) {
      await instance.connect();
    }
  }
}

module.exports = new Command("emulators:start")
  .before(async (options: any) => {
    await requireConfig(options);
    if (!options.ws) {
      await requireAuth(options);
      await getProjectNumber(options);
    }
  })
  .description("start the local Firebase emulators")
  .option(
    "--only <list>",
    "only run specific emulators. " +
      "This is a comma separated list of emulators to start. " +
      "Valid options are: " +
      JSON.stringify(VALID_EMULATORS)
  )
  .option(
    "--script <string>",
    "Run a specific testing script once the emulators have started up. " +
      "The command will start the emulators, run the script, and then exit."
  )
  .option("--ws <string>", "[Experimental] Set this address as the emulators' WebSocket debugger.")
  .action(async (options: any) => {
    let wsDebugger: WebSocketDebugger | undefined;
    let wsInitData: WebSocketDebuggerInitData | undefined;

    if (options.ws) {
      wsDebugger = new WebSocketDebugger(options.ws);
      wsInitData = await wsDebugger.getInitData();
      options.projectNumber = wsInitData.projectNumber;
    }

    try {
      await startAll(options, wsInitData);
    } catch (e) {
      console.error(e);
      await cleanShutdown();
      throw e;
    }

    // If the 'script' option is passed then we just run the script
    // and exit.
    if (options.script) {
      return runScript(options.script)
        .then(cleanShutdown)
        .catch(cleanShutdown);
    }

    const stopConditions: Array<Promise<any>> = [];

    // Hang until explicitly killed
    stopConditions.push(
      new Promise((res, rej) => {
        process.on("SIGINT", () => {
          cleanShutdown()
            .then(res)
            .catch(res);
        });
      })
    );

    if (options.ws && wsDebugger) {
      stopConditions.push(
        new Promise((resolve) => {
          wsDebugger!.onStop(async () => {
            await cleanShutdown();
            resolve();
          });
        })
      );
    }
  });
