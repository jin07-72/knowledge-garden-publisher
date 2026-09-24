import { contextBridge, ipcRenderer } from "electron"
import { createGardenApi } from "./gardenApi"

contextBridge.exposeInMainWorld("garden", createGardenApi(ipcRenderer))
