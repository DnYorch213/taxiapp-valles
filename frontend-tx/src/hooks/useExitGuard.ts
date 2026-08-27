import { useEffect, useCallback } from "react";
import { useNavigate, useBlocker } from "react-router-dom";
import { useTravel } from "../context/TravelContext";

export const useExitGuard = (enabled: boolean) => {
  const navigate = useNavigate();
  const { exitAttemptCount, requestExit, confirmExit, cancelExit, logout } = useTravel();

  const handleBeforeUnload = useCallback(
    (event: BeforeUnloadEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.returnValue = "";
    },
    [enabled]
  );

  const handlePopState = useCallback(
    (event: PopStateEvent) => {
      if (!enabled) return;
      event.preventDefault();
      requestExit(() => {
        logout();
      });
    },
    [enabled, requestExit, logout]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [enabled, handleBeforeUnload, handlePopState]);

  const confirm = useCallback(() => {
    confirmExit();
  }, [confirmExit]);

  const cancel = useCallback(() => {
    cancelExit();
  }, [cancelExit]);

  return {
    exitAttemptCount,
    confirmExit: confirm,
    cancelExit: cancel,
    requestExit,
  };
};
