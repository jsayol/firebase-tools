import * as path from "path";
import * as fs from "fs";
import * as util from "util";
import { spawnSync } from "child_process";
import * as admin from "firebase-admin";
import { URL } from "url";
import * as express from "express";

import {
  EmulatedTrigger,
  FunctionsRuntimeBundle,
  FunctionsRuntimeFeatures,
  getTemporarySocketPath,
  getTriggersFromDirectory,
  waitForBody,
} from "./functionsEmulatorShared";
import { EmulatorLog } from "./types";
import { _extractParamsFromPath } from "./functionsEmulatorUtils";

const resolve = require.resolve;
function _requireResolvePolyfill(moduleName: string, opts: { paths: string[] }): string {
  /*
  It's a story as old as time. Girl meets boy named Node 8 and things are great. Boy's
  older brother Node 6 is rude and refuses to resolve modules outside it's current folder
  hierarchy, but the girl *needs* modules to be resolved to an external folder's modules
  in order to mock them properly in require's cache.

  So girl goes and implements a polyfill which places a temporary script into the tree
  in the correct place so the older boy's resolution will take place in there, thus
  allowing the girl's primary process to resolve the package manually and mock it as
  intended before cleaning up the temporary script and moving on.
   */
  if (process.versions.node.startsWith("6.")) {
    const resolverScript = path.join(path.resolve(opts.paths[0]), ".resolve_polyfill.js");
    const resolver = `console.log(require.resolve(process.argv[2]))`;

    fs.writeFileSync(resolverScript, resolver);
    const result = spawnSync(process.execPath, [resolverScript, moduleName]);
    fs.unlinkSync(resolverScript);

    const filepath = result.stdout.toString();
    const hierarchy = filepath.split("/");

    for (let i = 1; i < hierarchy.length; i++) {
      try {
        const packagePath = path.join(hierarchy.slice(0, -i).join("/"), "package.json");
        const serializedPackage = fs.readFileSync(packagePath).toString();
        if (JSON.parse(serializedPackage).name === moduleName) {
          return hierarchy.slice(0, -i).join("/");
        }
        break;
      } catch (err) {
        /**/
      }
    }

    return "";
  } else {
    return resolve(moduleName, opts);
  }
}
require.resolve = _requireResolvePolyfill as RequireResolve;

function _InitializeNetworkFiltering(triggerId?: string): void {
  /*
    We mock out a ton of different paths that we can take to network I/O. It doesn't matter if they
    overlap (like TLS and HTTPS) because the dev will either whitelist, block, or allow for one
    invocation on the first prompt, so we can be aggressive here.

    Sadly, these vary a lot between Node versions and it will always be possible to route around
    this, it's not security - just a helper. A good example of somet  SimpleBodyParser,
hing difficult to catch is
    any I/O done via node-gyp (https://github.com/nodejs/node-gyp) s  SimpleBodyParser,
ince that I/O will be done in
    C, we have to catch it before then (which is how the google-gax   SimpleBodyParser,
blocker works). As of this note,
    GRPC uses a native extension to do I/O (I think because old node  SimpleBodyParser,
 lacks native HTTP2?), so that's
    a place to keep an eye on. Luckily, mostly only Google uses GRPC and most Google APIs go via
    google-gax, but still.

    So yeah, we'll try our best and hopefully we can catch 90% of requests.
   */
  const networkingModules = [
    { module: "http", path: ["request"] },
    { module: "http", path: ["get"] },
    { module: "https", path: ["request"] },
    { module: "https", path: ["get"] },
    { module: "net", path: ["connect"] },
    { module: "http2", path: ["connect"] },
    { module: "google-gax", path: ["GrpcClient"] },
  ];

  const results = networkingModules.map((bundle) => {
    let mod: any;
    try {
      mod = require(bundle.module);
    } catch (error) {
      return { bundle, status: "error", error };
    }

    let obj = mod;
    for (const field of bundle.path.slice(0, -1)) {
      obj = obj[field];
    }

    const method = bundle.path.slice(-1)[0];
    const original = obj[method].bind(mod);

    /* tslint:disable:only-arrow-functions */
    // This can't be an arrow function because it needs to be new'able
    mod[method] = function(...args: any[]): any {
      const hrefs = args
        .map((arg) => {
          if (typeof arg === "string") {
            try {
              const _ = new URL(arg);
              return arg;
            } catch (err) {
              return;
            }
          } else if (typeof arg === "object") {
            return arg.href;
          } else {
            return;
          }
        })
        .filter((v) => v);
      const href = (hrefs.length && hrefs[0]) || "";
      if (href.indexOf("googleapis.com") !== -1) {
        new EmulatorLog("SYSTEM", "googleapis-network-access", "", {
          href,
          module: bundle.module,
          triggerId,
        }).log();
      } else {
        new EmulatorLog("SYSTEM", "unidentified-network-access", "", {
          href,
          module: bundle.module,
          triggerId,
        }).log();
      }

      try {
        return original(...args);
      } catch (e) {
        return new original(...args);
      }
    };

    return { bundle, status: "mocked" };
  });

  new EmulatorLog(
    "DEBUG",
    "runtime-status",
    "Outgoing network have been stubbed.",
    triggerId ? { results, triggerId } : results
  ).log();
}

function _InitializeFirebaseAdminStubs(
  projectId: string,
  functionsDir: string,
  firestorePort: number,
  triggerId?: string
): admin.app.App | void {
  const adminResolution = require.resolve("firebase-admin", {
    paths: [path.join(functionsDir, "node_modules")],
  });

  const grpc = require(require.resolve("grpc", {
    paths: [path.join(functionsDir, "node_modules")],
  }));

  const localAdminModule = require(adminResolution);
  const validApp = localAdminModule.initializeApp({ projectId });

  if (firestorePort > 0) {
    validApp.firestore().settings({
      projectId,
      port: firestorePort,
      servicePath: "localhost",
      service: "firestore.googleapis.com",
      sslCreds: grpc.credentials.createInsecure(),
    });
  }

  const originalInitializeApp = localAdminModule.initializeApp.bind(localAdminModule);
  localAdminModule.initializeApp = (opts: any, name: string) => {
    {
      if (name) {
        new EmulatorLog("SYSTEM", "non-default-admin-app-used", "", { name, triggerId }).log();
        return originalInitializeApp(opts, name);
      }
      new EmulatorLog("SYSTEM", "default-admin-app-used", "", { triggerId }).log();
      return validApp;
    }
  };

  require.cache[adminResolution] = {
    exports: localAdminModule,
  };

  return validApp;
}

function _InitializeEnvironmentalVariables(projectId: string): void {
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId });
  process.env.FIREBASE_PROJECT = projectId;
  process.env.GCLOUD_PROJECT = projectId;
}

function _InitializeFunctionsConfigHelper(functionsDir: string, triggerId?: string): void {
  const functionsResolution = require.resolve("firebase-functions", {
    paths: [path.join(functionsDir, "node_modules")],
  });

  const ff = require(functionsResolution);

  const config = ff.config();
  new EmulatorLog("DEBUG", "runtime-status", "Checked functions.config()", {
    config: ff.config(),
    triggerId,
  }).log();

  const serviceProxy = new Proxy(config, {
    get(target, name): any {
      const proxyPath = [name.toString()];
      return new Proxy(
        {},
        {
          get(ftarget, fname): any {
            proxyPath.push(fname.toString());
            const value =
              typeof config[proxyPath[0]] === "object" && config[proxyPath[0]][proxyPath[1]];
            if (value) {
              return value;
            } else {
              new EmulatorLog(
                "WARN",
                "functions-config-missing-value",
                `You attempted to read a non-existent config() value "${proxyPath.join(
                  "."
                )}" for information on how to set runtime configuration values in the emulator, \
see https://firebase.google.com/docs/functions/local-emulator`,
                { triggerId }
              ).log();
              return undefined;
            }
          },
        }
      );
    },
  });

  (ff as any).config = () => serviceProxy;
}

async function _ProcessHTTPS(
  trigger: EmulatedTrigger,
  enhancedLogs = false,
  isDebugging = false
): Promise<void> {
  const ephemeralServer = express();
  const socketPath = getTemporarySocketPath(process.pid);

  return new Promise((resolveEphemeralServer) => {
    const handler = async (req: express.Request, res: express.Response) => {
      new EmulatorLog(
        "DEBUG",
        "runtime-status",
        `Ephemeral server used!`,
        enhancedLogs ? { triggerId: trigger.definition.name } : undefined
      ).log();
      const func = trigger.getRawFunction();

      res.on("finish", () => {
        instance.close();
        resolveEphemeralServer();
      });

      // Read data and manually set the request body
      const dataStr = await waitForBody(req);
      if (dataStr && dataStr.length > 0) {
        if (req.is("application/json")) {
          new EmulatorLog(
            "DEBUG",
            "runtime-status",
            `Detected JSON request body: ${dataStr}`,
            enhancedLogs ? { triggerId: trigger.definition.name } : undefined
          ).log();
          req.body = JSON.parse(dataStr);
        } else {
          req.body = dataStr;
        }
      }

      await Run([req, res], func, enhancedLogs, isDebugging, trigger.definition.name);
    };

    ephemeralServer.get("/*", handler);
    ephemeralServer.post("/*", handler);

    const instance = ephemeralServer.listen(socketPath, () => {
      new EmulatorLog("SYSTEM", "runtime-status", "ready", {
        socketPath,
        triggerId: enhancedLogs ? trigger.definition.name : undefined,
      }).log();
    });
  });
}

async function _ProcessBackground(
  app: admin.app.App,
  proto: any,
  trigger: EmulatedTrigger,
  enhancedLogs: boolean,
  isDebugging: boolean
): Promise<void> {
  new EmulatorLog(
    "SYSTEM",
    "runtime-status",
    "ready",
    enhancedLogs ? { triggerId: trigger.definition.name } : undefined
  ).log();
  const { Change } = require("firebase-functions");

  const newSnap =
    proto.data.value &&
    (app.firestore() as any).snapshot_(proto.data.value, new Date().toISOString(), "json");
  const oldSnap =
    proto.data.oldValue &&
    (app.firestore() as any).snapshot_(proto.data.oldValue, new Date().toISOString(), "json");

  let data;
  switch (proto.context.eventType) {
    case "providers/cloud.firestore/eventTypes/document.write":
      data = Change.fromObjects(oldSnap, newSnap);
      break;
    case "providers/cloud.firestore/eventTypes/document.delete":
      data = Change.fromObjects(oldSnap, newSnap);
      break;
    default:
      data = newSnap && oldSnap ? Change.fromObjects(oldSnap, newSnap) : newSnap;
  }

  const resourcePath = proto.context.resource.name;
  const params = _extractParamsFromPath(trigger.definition.eventTrigger.resource, resourcePath);

  const ctx = {
    eventId: proto.context.eventId,
    timestamp: proto.context.timestamp,
    params,
    auth: {},
    authType: "UNAUTHENTICATED",
  };

  new EmulatorLog(
    "DEBUG",
    "runtime-status",
    `Requesting a wrapped function.`,
    enhancedLogs ? { triggerId: trigger.definition.name } : undefined
  ).log();
  const func = trigger.getWrappedFunction();

  await Run([data, ctx], func, enhancedLogs, isDebugging, trigger.definition.name);
}

// TODO(abehaskins): This signature could probably use work lol
async function Run(
  args: any[],
  func: (a: any, b: any) => Promise<any>,
  enhancedLogs: boolean,
  isDebugging: boolean,
  triggerId: string
): Promise<any> {
  if (args.length < 2) {
    throw new Error("Function must be passed 2 args.");
  }

  const inspectOptions = {
    depth: null,
    colors: true,
    compact: false,
    maxArrayLength: Infinity,
  };

  /* tslint:disable:no-console */

  const originalConsoleFn = {
    log: console.log,
    info: console.info,
    error: console.error,
  };

  if (!isDebugging) {
    const consoleFn = (type: "log" | "error") => (...messages: any[]) => {
      const content = messages
        .map((message: any) => {
          return !enhancedLogs || typeof message === "string"
            ? message
            : util.inspect(message, inspectOptions);
        })
        .join(" ");
      new EmulatorLog(
        "USER",
        "function-" + type,
        content,
        enhancedLogs ? { triggerId } : undefined
      ).log();
    };

    console.log = consoleFn("log");
    console.info = consoleFn("log");
    if (enhancedLogs) {
      console.error = consoleFn("error");
    }
  }

  let caughtErr;
  try {
    await func(args[0], args[1]);
  } catch (err) {
    caughtErr = err;
    console.warn(caughtErr);
  }

  if (!isDebugging) {
    console.log = originalConsoleFn.log;
    console.info = originalConsoleFn.info;
    console.error = originalConsoleFn.error;
  }

  /* tslint:enable:no-console */

  if (caughtErr) {
    new EmulatorLog(
      "WARN",
      "function-log",
      caughtErr.stack,
      enhancedLogs ? { triggerId } : undefined
    ).log();
  }

  return;
}

function isFeatureEnabled(
  frb: FunctionsRuntimeBundle,
  feature: keyof FunctionsRuntimeFeatures
): boolean {
  return frb.disabled_features ? frb.disabled_features[feature] || false : true;
}

async function main(): Promise<void> {
  const serializedFunctionsRuntimeBundle = process.argv[2] || "{}";
  const serializedFunctionTrigger = process.argv[3];

  let enhancedLogs = false;
  let isDebugging = false;
  if (process.argv.length > 4) {
    for (let i = 4; i <= process.argv.length; i++) {
      switch (process.argv[i]) {
        case "--enhance-logs":
          enhancedLogs = true;
          break;
        case "--is-debugging":
          isDebugging = true;
          break;
      }
    }
  }

  let frb: FunctionsRuntimeBundle;

  if (enhancedLogs) {
    // For enhanced logs we need to know the triggerId for every item logged, including the first one.
    frb = JSON.parse(serializedFunctionsRuntimeBundle);
    new EmulatorLog("DEBUG", "runtime-status", "Functions runtime initialized.", {
      cwd: process.cwd(),
      node_version: process.versions.node,
      triggerId: frb.triggerId,
    }).log();
  } else {
    new EmulatorLog("DEBUG", "runtime-status", "Functions runtime initialized.", {
      cwd: process.cwd(),
      node_version: process.versions.node,
    }).log();

    frb = JSON.parse(serializedFunctionsRuntimeBundle) as FunctionsRuntimeBundle;
  }

  new EmulatorLog("DEBUG", "runtime-status", "FunctionsRuntimeBundle parsed", frb).log();

  _InitializeEnvironmentalVariables(frb.projectId);
  if (isFeatureEnabled(frb, "network_filtering")) {
    _InitializeNetworkFiltering(enhancedLogs ? frb.triggerId : undefined);
  }

  if (isFeatureEnabled(frb, "functions_config_helper")) {
    _InitializeFunctionsConfigHelper(frb.cwd, enhancedLogs ? frb.triggerId : undefined);
  }

  const stubbedAdminApp = _InitializeFirebaseAdminStubs(
    frb.projectId,
    frb.cwd,
    frb.ports.firestore,
    enhancedLogs ? frb.triggerId : undefined
  );

  if (!stubbedAdminApp) {
    new EmulatorLog(
      "FATAL",
      "runtime-status",
      "Could not initialize stubbed admin app.",
      enhancedLogs ? { triggerId: frb.triggerId } : undefined
    ).log();
    return process.exit();
  }

  let triggers: { [id: string]: EmulatedTrigger };

  if (serializedFunctionTrigger) {
    /* tslint:disable:no-eval */
    const triggerModule = eval(serializedFunctionTrigger);
    triggers = {
      [frb.triggerId]: EmulatedTrigger.fromModule(
        {
          entryPoint: frb.triggerId,
          name: frb.triggerId,
          eventTrigger: frb.proto ? { resource: frb.proto.context.resource.name } : {},
        },
        triggerModule()
      ),
    };
  } else {
    // TODO: Figure out what the right thing to do with FIREBASE_CONFIG is
    triggers = await getTriggersFromDirectory(
      frb.projectId,
      frb.cwd,
      JSON.parse(process.env.FIREBASE_CONFIG || "{}")
    );
  }

  if (!triggers[frb.triggerId]) {
    new EmulatorLog(
      "FATAL",
      "runtime-status",
      `Could not find trigger "${frb.triggerId}" in your functions directory.`,
      enhancedLogs ? { triggerId: frb.triggerId } : undefined
    ).log();
    return;
  } else {
    new EmulatorLog(
      "DEBUG",
      "runtime-status",
      `Trigger "${frb.triggerId}" has been found, beginning invocation!`,
      enhancedLogs ? { triggerId: frb.triggerId } : undefined
    ).log();
  }

  if (enhancedLogs) {
    new EmulatorLog(
      "INFO",
      "runtime-status",
      `Function ${frb.triggerId} started${isDebugging ? " for debugging" : ""}.`,
      {
        triggerId: frb.triggerId,
        skipStdout: true,
      }
    ).log();
  }

  const trigger = triggers[frb.triggerId];

  let timeoutId;
  if (isFeatureEnabled(frb, "timeout") && !isDebugging) {
    timeoutId = setTimeout(() => {
      new EmulatorLog(
        "WARN",
        "runtime-status",
        `Your function timed out after ~${
          trigger.definition.timeout
        }. To configure this timeout, see
      https://firebase.google.com/docs/functions/manage-functions#set_timeout_and_memory_allocation.`,
        enhancedLogs ? { triggerId: frb.triggerId } : undefined
      ).log();
      process.exit();
    }, trigger.timeout);
  }

  // Note: for finer duration (ns) use `performance` from `perf_hooks` Node module
  const startTime = Date.now();

  switch (frb.mode) {
    case "BACKGROUND":
      await _ProcessBackground(
        stubbedAdminApp,
        frb.proto,
        triggers[frb.triggerId],
        enhancedLogs,
        isDebugging
      );
      break;
    case "HTTPS":
      await _ProcessHTTPS(triggers[frb.triggerId], enhancedLogs, isDebugging);
      break;
  }

  const time = Date.now() - startTime;
  const duration = time >= 1000 ? `~${Math.round(time / 100) / 10} seconds` : `${time} ms`;

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  new EmulatorLog(
    "INFO",
    "runtime-status",
    `Function ${frb.triggerId} finished in ${duration}.`,
    enhancedLogs ? { triggerId: frb.triggerId, skipStdout: true } : undefined
  ).log();
}

if (require.main === module) {
  main().catch((err) => {
    throw err;
  });
} else {
  throw new Error(
    "functionsEmulatorRuntime.js should not be required/imported. It should only be spawned via InvokeRuntime()"
  );
}
