import { useDispatch, useSelector, shallowEqual, type TypedUseSelectorHook } from "react-redux";
import type { AppDispatch, RootState } from ".";
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

/** 配合返回新对象/数组的 selector（shallowEqual 比较），避免每次渲染都触发重渲染 */
export const useShallowEqualSelector: TypedUseSelectorHook<RootState> = (selector) =>
  useSelector(selector, shallowEqual);
