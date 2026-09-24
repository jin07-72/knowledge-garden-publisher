import { contextBridge, ipcRenderer } from "electron"
import { shouldExposeGardenApi } from "../shared/rendererTrust"
import { createGardenApi } from "./gardenApi"

if (shouldExposeGardenApi(globalThis.location.href, process.argv)) {
  contextBridge.exposeInMainWorld("garden", createGardenApi(ipcRenderer))
}
