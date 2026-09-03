import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const pocketBaseLauncher = fs.readFileSync(
  new URL("../scripts/start-pocketbase.ps1", import.meta.url),
  "utf8",
);
const factoryHelpers = fs.readFileSync(
  new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url),
  "utf8",
);
const runtimeEnvironment = { LUMINA_UI_MODE: "local-loopback" };
class ForbiddenError extends Error {}
const sandbox = {
  module: { exports: {} },
  exports: {},
  $os: {
    getenv: (name) => runtimeEnvironment[name] || "",
  },
  ForbiddenError,
  Math,
  JSON,
  String,
  Number,
  Array,
  Object,
  Set,
  Error,
};
vm.runInNewContext(factoryHelpers, sandbox);
const { authorizeUi } = sandbox.module.exports;

function uiRequest({ origin = "", host, marker = "local", rawHeaders = false }) {
  const values = {
    ...(origin ? { origin } : {}),
    ...(marker ? { "x-lumina-ui": marker } : {}),
  };
  const infoHeaders = rawHeaders ? {} : values;
  return {
    requestInfo: () => ({ headers: infoHeaders }),
    request: {
      host,
      header: {
        get: (name) => values[String(name).toLowerCase()] || "",
      },
    },
  };
}

test("local PocketBase always loads hooks and migrations from this checkout", () => {
  assert.match(pocketBaseLauncher, /Join-Path \$workspace "pb_hooks"/);
  assert.match(pocketBaseLauncher, /Join-Path \$workspace "pb_migrations"/);
  assert.doesNotMatch(pocketBaseLauncher, /overseasdrama-external-hook/);
});

test("local UI authorization accepts supported loopback browser origins", () => {
  for (const [address, port] of [
    ["localhost", "3000"],
    ["127.0.0.1", "8094"],
    ["[::1]", "3001"],
  ]) {
    assert.doesNotThrow(() => authorizeUi(uiRequest({
      origin: `http://${address}:${port}`,
      host: `${address}:${port}`,
      rawHeaders: address === "[::1]",
    })));
  }
});

test("local UI authorization accepts Vite's originless loopback proxy", () => {
  assert.doesNotThrow(() =>
    authorizeUi(uiRequest({ host: "[::1]:3000", origin: "" })),
  );
  assert.doesNotThrow(() =>
    authorizeUi(uiRequest({ host: "127.0.0.1:8094", origin: "" })),
  );
});

test("local PocketBase launcher supports an isolated port", () => {
  assert.match(pocketBaseLauncher, /\[int\]\$Port = 8090/);
  assert.match(pocketBaseLauncher, /--http="127\.0\.0\.1:\$Port"/);
});

test("local UI authorization rejects forged remote and lookalike requests", () => {
  const requests = [
    uiRequest({ origin: "https://evil.example", host: "evil.example" }),
    uiRequest({
      origin: "http://localhost.evil:3000",
      host: "localhost.evil:3000",
    }),
    uiRequest({ origin: "http://localhost:3000", host: "evil.example" }),
    uiRequest({ origin: "", host: "evil.example" }),
    uiRequest({ origin: "http://[::2]:3000", host: "[::2]:3000" }),
  ];
  for (const request of requests)
    assert.throws(() => authorizeUi(request), /Local UI only/);
});

test("local UI authorization requires the proxy marker and local mode", () => {
  assert.throws(
    () =>
      authorizeUi(
        uiRequest({
          origin: "http://localhost:3000",
          host: "localhost:3000",
          marker: "",
        }),
      ),
    /Local UI only/,
  );
  runtimeEnvironment.LUMINA_UI_MODE = "";
  try {
    assert.throws(
      () =>
        authorizeUi(
          uiRequest({
            origin: "http://localhost:3000",
            host: "localhost:3000",
          }),
        ),
      /Local UI only/,
    );
  } finally {
    runtimeEnvironment.LUMINA_UI_MODE = "local-loopback";
  }
});
