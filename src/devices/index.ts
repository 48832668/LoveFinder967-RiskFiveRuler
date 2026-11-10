/**
 * 器件层入口：注册表（`devices/registry.ts`）+ WCH 元数据兜底（`devices/wch.ts`）。
 *
 * UI / app / backends 只从这里取器件，不直接读 `data/*.json`。
 */
export {
  DEVICES,
  DEVICE_MAP,
  SERIES,
  PACK_OF_SERIES,
  seriesOf,
  deviceById,
  defaultDeviceId,
  sdkHeaderOf,
} from "./registry";
export type { DevicePart, DeviceSeries } from "./registry";
export { metaOf } from "./wch";
