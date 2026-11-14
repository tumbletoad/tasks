# Lab checks (M0.05)

Small scripts for the rows of lab run R (A7 3.7) that have no other spike: R07, R08, R10, R11 and R12. Lab code: nothing outside `spikes/` imports it and it is thrown away after M0. Node built-ins only, so each script runs as a plain `.ts` file on the packaged Node 26.13.1 of the spike archive, with nothing installed. Each prints its observation and writes one JSON result into the folder given with `--out`. Result files hold no paths, host names or identifiers.

| Script | Row | Usage |
|---|---|---|
| `sync-detect.ts` | R07 | `--out <dir> [--defaults] [--provider-roots] [--target <label>=<path>]… [--no-list]` |
| `driver-smoke.ts` | R08 | `--package <scratch>/node_modules/better-sqlite3 --scratch <empty dir> --out <dir>` |
| `owner-only.ts` | R10 | `--scratch <empty dir> --out <dir>` |
| `machine-id.ts` | R11 | `--out <dir>` |
| `smart-app-control.ts` | R12 | `--out <dir>` (Windows; elsewhere "not applicable") |

- `sync-detect.ts --defaults` computes `~/Tasks` and the A2 3.2.1 folders of the OS and never creates them. `--provider-roots` judges every sync root it found (environment, registry, client files) with listing off, so nothing inside a sync folder is read.
- `driver-smoke.ts` expects the package installed beforehand in a scratch folder outside the workspace, for example `npm install better-sqlite3@13.0.3 --ignore-scripts` with `npm_config_cache` inside that folder.
- On Windows the scripts read the registry through Windows PowerShell 5.1 by absolute path, with fixed scripts and inputs passed in `TASKS_LAB_*` variables.
- `owner-only.ts` reuses the spike kit's permission code (`../kit/perms.ts`, Node built-ins only): `setUserOnlyAcl` gives the secrets folder a protected DACL with exactly the user, removing inheritance and every other explicit allow entry, and `readAcls` reads each ACL as SDDL by SID and refuses conditional entries.

`checks.test.ts` (manifest ID `A7.3.7.lab-checks.self-test`) runs the detector on fixture trees, the owner-only check in a temporary folder, and the identifier and Smart App Control classifiers. It reads no real home, sync or state folder and no identifier.

The run's results are kept outside the repository (A7 3.7).
