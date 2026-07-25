/** 控制面独立入口：node --import tsx server/cli.ts 或编译后运行 */
import { startControlPlane } from "./control-plane/index";

startControlPlane();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));