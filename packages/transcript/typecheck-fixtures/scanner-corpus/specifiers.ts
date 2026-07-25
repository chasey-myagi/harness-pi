/// <reference types="node" />
/// <reference path="./phantom.d.ts" />
import * as fsStatic from "node:fs";
export * from "node:os";
import legacyRequire = require("node:child_process");
type ImportTypeProbe = import("node:crypto").Hash;
const dynamic = () => import(`node:stream`);
const cjs = require("node:path");
const subpath = () => import("fs/promises");
const relativeOk = () => import("./negative-control.js");
export { fsStatic, legacyRequire, dynamic, cjs, subpath, relativeOk };
export type { ImportTypeProbe };
