import { useMemo, useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function useConfirm() {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    resolve?: (ok: boolean) => void;
  }>({ open: false, title: "" });

  const confirm = useMemo(
    () =>
      (opts: {
        title: string;
        description?: string;
        confirmText?: string;
        cancelText?: string;
        danger?: boolean;
      }) =>
        new Promise<boolean>((resolve) => {
          setState({
            open: true,
            title: opts.title,
            description: opts.description,
            confirmText: opts.confirmText,
            cancelText: opts.cancelText,
            danger: opts.danger,
            resolve,
          });
        }),
    [],
  );

  const close = (ok: boolean) => {
    state.resolve?.(ok);
    setState((s) => ({ ...s, open: false, resolve: undefined }));
  };

  const node = (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      <DialogContent size="sm" showClose={false} className="app-confirm-dialog">
        <DialogHeader className="app-confirm-header">
          <span className={cn("app-confirm-symbol", state.danger && "is-danger")} aria-hidden="true">
            {state.danger ? <CircleAlert /> : <Info />}
          </span>
          <div className="app-confirm-message">
            <DialogTitle>{state.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {state.description || "请确认后继续。"}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="app-confirm-footer">
          <Button
            type="button"
            variant="outline"
            className="app-confirm-button app-confirm-button-cancel"
            onClick={() => close(false)}
          >
            {state.cancelText || "取消"}
          </Button>
          <Button
            type="button"
            variant={state.danger ? "destructive" : "default"}
            className={cn(
              "app-confirm-button app-confirm-button-primary",
              state.danger && "is-danger",
            )}
            onClick={() => close(true)}
          >
            {state.confirmText || "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, ConfirmDialog: node };
}
