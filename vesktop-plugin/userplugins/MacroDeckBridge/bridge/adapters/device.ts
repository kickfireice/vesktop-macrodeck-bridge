/** adapters/device.ts — DeviceAdapter: input/output device select + cycle + refresh. */
import { tryFind, tryStore } from "./discovery";
import type { Device } from "../protocol";
import { log } from "../logger";

function mediaDevices(): any | null {
  return tryStore("MediaDeviceStore", ["MediaDeviceStore"],
    ["getInputDevices", "getOutputDevices"],
    ["getDevices", "setInputDevice"],
    ["enumerateDevices"]);
}

function norm(s: string) { return (s || "").trim().toLowerCase(); }

export function deviceAvailability() {
  const md = mediaDevices();
  return {
    inputDeviceSelect: !!md, outputDeviceSelect: !!md, deviceList: !!md,
    reasons: md ? {} : {
      inputDeviceSelect: "INTERNAL_ERROR: MediaDeviceStore",
      outputDeviceSelect: "INTERNAL_ERROR: MediaDeviceStore",
      deviceList: "INTERNAL_ERROR: MediaDeviceStore",
    } as Record<string, string>,
  };
}

function toDevices(raw: any, kind: "input" | "output"): Device[] {
  if (!raw) return [];
  const arr: any[] = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  return arr.slice(0, 50).map((d: any, i: number) => ({
    id: String(d?.id ?? d?.deviceId ?? `${kind}-${i}`),
    name: String(d?.name ?? d?.label ?? `${kind} ${i}`),
    kind,
    isDefault: !!(d?.isDefault ?? d?.default ?? i === 0),
  }));
}

export const DeviceAdapter = {
  list(): { inputs: Device[]; outputs: Device[] } {
    try {
      const md = mediaDevices(); if (!md) return { inputs: [], outputs: [] };
      const ins = typeof md.getInputDevices === "function" ? md.getInputDevices()
        : typeof md.getDevices === "function" ? md.getDevices()?.inputs : [];
      const outs = typeof md.getOutputDevices === "function" ? md.getOutputDevices()
        : typeof md.getDevices === "function" ? md.getDevices()?.outputs : [];
      return { inputs: toDevices(ins, "input"), outputs: toDevices(outs, "output") };
    } catch { return { inputs: [], outputs: [] }; }
  },
  current(): { inputId: string | null; inputName: string | null; outputId: string | null; outputName: string | null } {
    try {
      const md = mediaDevices(); if (!md) return { inputId: null, inputName: null, outputId: null, outputName: null };
      const gi = typeof md.getInputDevice === "function" ? md.getInputDevice() : md.inputDevice;
      const go = typeof md.getOutputDevice === "function" ? md.getOutputDevice() : md.outputDevice;
      return {
        inputId: gi ? String(gi.id ?? gi.deviceId ?? gi) : null,
        inputName: gi?.name ?? gi?.label ?? null,
        outputId: go ? String(go.id ?? go.deviceId ?? go) : null,
        outputName: go?.name ?? go?.label ?? null,
      };
    } catch { return { inputId: null, inputName: null, outputId: null, outputName: null }; }
  },
  setInputById(deviceId: string) {
    const md = mediaDevices(); if (!md) return { ok: false, code: "UNSUPPORTED", message: "input device unavailable" };
    try {
      if (typeof md.setInputDevice === "function") { md.setInputDevice(deviceId); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no input setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  setOutputById(deviceId: string) {
    const md = mediaDevices(); if (!md) return { ok: false, code: "UNSUPPORTED", message: "output device unavailable" };
    try {
      if (typeof md.setOutputDevice === "function") { md.setOutputDevice(deviceId); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no output setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  setInputByName(name: string) {
    const { inputs } = DeviceAdapter.list();
    const hits = inputs.filter(d => norm(d.name) === norm(name));
    if (hits.length === 0) return { ok: false, code: "NOT_FOUND", message: `input device "${name}" not found` };
    if (hits.length > 1) return { ok: false, code: "AMBIGUOUS", message: "multiple inputs match", candidates: hits.slice(0, 10) };
    return DeviceAdapter.setInputById(hits[0].id);
  },
  setOutputByName(name: string) {
    const { outputs } = DeviceAdapter.list();
    const hits = outputs.filter(d => norm(d.name) === norm(name));
    if (hits.length === 0) return { ok: false, code: "NOT_FOUND", message: `output device "${name}" not found` };
    if (hits.length > 1) return { ok: false, code: "AMBIGUOUS", message: "multiple outputs match", candidates: hits.slice(0, 10) };
    return DeviceAdapter.setOutputById(hits[0].id);
  },
  cycle(kind: "input" | "output", direction: "next" | "prev" = "next") {
    const { inputs, outputs } = DeviceAdapter.list();
    const list = kind === "input" ? inputs : outputs;
    if (list.length === 0) return { ok: false, code: "NOT_FOUND", message: `no ${kind} devices` };
    const cur = DeviceAdapter.current();
    const curId = kind === "input" ? cur.inputId : cur.outputId;
    let idx = list.findIndex(d => d.id === curId);
    idx = idx < 0 ? 0 : (idx + (direction === "next" ? 1 : -1) + list.length) % list.length;
    const target = list[idx];
    const r = kind === "input" ? DeviceAdapter.setInputById(target.id) : DeviceAdapter.setOutputById(target.id);
    return { ...r, device: target };
  },
  refresh() {
    try {
      const md = mediaDevices(); if (!md) return { ok: false, code: "UNSUPPORTED", message: "device refresh unavailable" };
      if (typeof md.refresh === "function") md.refresh();
      else if (typeof md.enumerateDevices === "function") md.enumerateDevices();
      else log.debug("device", "no refresh fn; list re-read on demand");
      return { ok: true };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
};
