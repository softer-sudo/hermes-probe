export interface Sample {
  t: number;
  phase: string;
  label: string;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

export type Sampler = (phase: string, label: string) => void;
