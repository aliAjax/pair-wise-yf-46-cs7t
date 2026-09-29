import { configureStore } from "@reduxjs/toolkit";
import rundownReducer from "./rundownSlice";

export const store = configureStore({
  reducer: { rundown: rundownReducer },
});
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
