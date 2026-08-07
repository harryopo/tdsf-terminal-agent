import { useEffect, useRef } from "react";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  markBooted: () => void;
};

/**
 * 启动引导：每次启动回到初始的选择/新建工作区界面。
 *
 * TDSF 修复 2026-08-07: 用户明确要求"重启后回到初始的选择/新建工作区界面,
 * 不用记住"——SSH 服务器可能已关闭, 恢复持久化的 SSH Space 会携带上次
 * 生命周期的幽灵 sessionId (应用重启后会话不存在), 导致终端显示本地、
 * 资源管理器不接管。因此**忽略持久化数据**, 每次启动由用户通过欢迎界面
 * 显式新建本地工作区或 SSH 服务器。持久化写入逻辑保留（LazyStore 仍会
 * 保存），只是启动不再恢复。
 */
export function useSpacesBoot({ ready, markBooted }: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    useSpaces.getState().hydrate([], null);
    markBooted();
  }, [ready, markBooted]);
}
