export function sourceIdentity(directory?: string): {
  commit: string;
  workingTreeDirty: boolean;
  sourceFingerprint: string;
};
