import { configureStore } from "@reduxjs/toolkit";
import rundownReducer, { loadPersisted, persistLocal } from "./rundownSlice";
import { rundownApi } from "./api";

const persisted = loadPersisted();

export const store = configureStore({
  reducer: { rundown: rundownReducer, [rundownApi.reducerPath]: rundownApi.reducer },
  middleware: (getDefault) => getDefault().concat(rundownApi.middleware),
  preloadedState: persisted ? { rundown: persisted } : undefined
});

// 本地工作区（含应急队列）持久化，断网刷新不丢
store.subscribe(() => {
  const { rundown } = store.getState();
  if (rundown.initialized) persistLocal(rundown);
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
