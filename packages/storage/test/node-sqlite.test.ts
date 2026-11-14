// The driver contract suite against the primary driver, node:sqlite (A1 3.19).
import { nodeSqliteDriver } from "../src/node-sqlite.ts";
import { driverContract } from "./driver-contract.ts";

driverContract({ name: "node:sqlite", create: () => nodeSqliteDriver });
