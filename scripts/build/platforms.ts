// The platforms a version folder is built for (A2 3.12.1): linux-x64, linux-arm64, win-x64 and
// darwin-arm64 (community-tested). glibc only on Linux, no musl. The names live in the product
// (packages/service/src/version/release.ts), whose updater reads what the build writes.
export {
  ARCHIVE_NAME,
  archiveName,
  hostPlatform,
  isPlatform,
  osOf,
  PLATFORMS,
  type Platform,
} from "../../packages/service/src/version/release.ts";
