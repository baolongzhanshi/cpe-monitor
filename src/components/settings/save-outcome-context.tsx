'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * 上一次保存是否失败。
 *
 * 各保存函数在失败时同样会把 saving 置回 false，所以 SaveButton 仅凭这个下降沿
 * 分不清成功还是失败，会误闪绿色「已保存」。结果只有设置页知道（它持有消息状态），
 * 这里把它广播给子树里的所有保存按钮，避免逐个组件透传。
 */
const SaveOutcomeContext = createContext(false);

export function SaveOutcomeProvider({ failed, children }: { failed: boolean; children: ReactNode }) {
  return <SaveOutcomeContext.Provider value={failed}>{children}</SaveOutcomeContext.Provider>;
}

export function useLastSaveFailed(): boolean {
  return useContext(SaveOutcomeContext);
}
