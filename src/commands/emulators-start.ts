import * as Command from "../command";
import * as controller from "../emulator/controller";
import getProjectNumber = require("../getProjectNumber");
import requireAuth = require("../requireAuth");
import requireConfig = require("../requireConfig");
import { EmulatorRegistry } from "../emulator/registry";
import { WebSocketDebugger, WebSocketDebuggerConfig } from "../emulator/websocketDebugger";

// tslint:disable-next-line: no-var-requires
const terminate = require("terminate");

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
      JSON.stringify(controller.VALID_EMULATOR_STRINGS)
  )
  .option("--ws <string>", "[Experimental] Set this address as the emulators' WebSocket debugger.")
  .action(async (options: any) => {
    if (options.ws) {
      const wsDebugger = new WebSocketDebugger(options.ws);
      EmulatorRegistry.setWebSocketDebugger(wsDebugger);
      options.projectNumber = (await wsDebugger.getConfig()).projectNumber;
    }

    try {
      await controller.startAll(options);
    } catch (e) {
      await controller.cleanShutdown();
      throw e;
    }

    // Hang until explicitly killed
    await new Promise((res, rej) => {
      process.on("SIGINT", () => {
        controller
          .cleanShutdown()
          .then(res)
          .catch(res);
      });
    });

    // This kills the current process and any dangling spawned child processes.
    return new Promise((resolve) => {
      terminate(process.pid, resolve);
    });
  });
