// Central Zustand store for high-frequency dashboard state.
//
// Why: App.tsx had 19 useState calls at the root. Every state change there
// caused the entire component tree to reconcile, including panels that didn't
// care about the change (e.g. LiDAR re-renders on a backend status pill toggle).
//
// Pattern: panels subscribe to specific slices via `useDashboardStore(s => s.x)`.
// Zustand uses Object.is for change detection, so identical values short-circuit
// without triggering React work.
//
// Migration plan: incrementally move state out of App.tsx into this store.
// Start with state that's both high-frequency AND read by leaf panels.

import { create } from "zustand";
import { shallow } from "zustand/shallow";
import type { BagFileOption, BagStatus, BagTopicSummary, LatestFrame } from "../types/liveMessages";

type DashboardState = {
  // Connection / source
  backendSource: string;
  backendError: string | null;
  selectedBagPath: string;
  bagFiles: BagFileOption[];

  // Playback
  bagStatus: BagStatus;
  latestFrame: LatestFrame | undefined;

  // Actions
  setBackendSource: (source: string) => void;
  setBackendError: (err: string | null) => void;
  setSelectedBagPath: (path: string) => void;
  setBagFiles: (files: BagFileOption[]) => void;
  setBagStatus: (status: BagStatus) => void;
  patchBagStatus: (patch: Partial<BagStatus>) => void;
  setLatestFrame: (frame: LatestFrame | undefined) => void;
  setBagTopics: (topics: BagTopicSummary[]) => void;
  resetPlayback: () => void;
};

const defaultBagStatus: BagStatus = {
  connected: false,
  playing: false,
  source: "none",
  path: "",
  frameCount: 0,
  cursor: 0,
  topics: [],
};

export const useDashboardStore = create<DashboardState>((set) => ({
  backendSource: "none",
  backendError: null,
  selectedBagPath: "",
  bagFiles: [],
  bagStatus: defaultBagStatus,
  latestFrame: undefined,

  setBackendSource: (source) => set({ backendSource: source }),
  setBackendError: (err) => set({ backendError: err }),
  setSelectedBagPath: (path) => set({ selectedBagPath: path }),
  setBagFiles: (files) => set({ bagFiles: files }),
  setBagStatus: (status) => set({ bagStatus: status }),
  patchBagStatus: (patch) => set((s) => ({ bagStatus: { ...s.bagStatus, ...patch } })),
  setLatestFrame: (frame) => set({ latestFrame: frame }),
  setBagTopics: (topics) => set((s) => ({ bagStatus: { ...s.bagStatus, topics } })),
  resetPlayback: () => set({
    bagStatus: defaultBagStatus,
    latestFrame: undefined,
  }),
}));

// Re-export shallow for callers that need it (e.g. selecting object slices).
export { shallow };
