import { useState } from "react";
import { Coins, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import {
  getApi,
  type BalanceAccount,
  type BalanceResult,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/layout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BalanceAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: BalanceAccount[];
  results: Record<string, BalanceResult>;
  probing: boolean;
  onAccountsChange: (accounts: BalanceAccount[]) => void;
  onProbe: () => Promise<void>;
}

export function BalanceAccountsDialog({
  open,
  onOpenChange,
  accounts,
  results,
  probing,
  onAccountsChange,
  onProbe,
}: BalanceAccountsDialogProps) {
  const api = getApi();
  const [editing, setEditing] = useState<BalanceAccount | null>(null);
  const [saving, setSaving] = useState(false);

  const addAccount = async () => {
    setEditing(await api.newBalanceTemplate({ type: "newapi" }));
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseURL?.trim()) {
      toast.error("请填写账户名称和站点地址");
      return;
    }
    if (!editing.apiKey.trim() && !editing.accessToken?.trim()) {
      toast.error("请填写 API Key 或访问令牌");
      return;
    }
    setSaving(true);
    try {
      const response = await api.upsertBalanceAccount(editing);
      onAccountsChange(response.accounts || []);
      setEditing(null);
      toast.success("余额账户已保存");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setSaving(true);
    try {
      const response = await api.removeBalanceAccount(id);
      onAccountsChange(response.accounts || []);
      if (editing?.id === id) setEditing(null);
      toast.success("余额账户已删除");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>供应商余额账户</DialogTitle>
          <DialogDescription>
            账户按站点地址与 Cursor 供应商自动关联，余额会直接显示在供应商列表。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid min-h-[320px] gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-2 border-r border-black/5 pr-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#777]">已配置账户</span>
              <Button size="icon" variant="ghost" title="添加账户" onClick={() => void addAccount()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {accounts.length === 0 ? (
              <button
                type="button"
                className="studio-subtle-surface w-full rounded-lg border border-dashed border-black/10 px-3 py-8 text-xs text-[#999]"
                onClick={() => void addAccount()}
              >
                添加 NewAPI 或 Sub2API 账户
              </button>
            ) : (
              accounts.map((account) => {
                const result = results[account.id];
                return (
                  <button
                    key={account.id}
                    type="button"
                    className={`studio-subtle-surface w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      editing?.id === account.id ? "border-black/40" : "border-black/5 hover:border-black/20"
                    }`}
                    onClick={() => setEditing({ ...account })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{account.name}</span>
                      <Badge variant={account.enabled === false ? "default" : "solid"}>{account.type}</Badge>
                    </div>
                    <div className={`mt-1 truncate text-xs ${result?.ok ? "text-emerald-700" : "text-[#999]"}`}>
                      {result ? (result.ok ? result.balanceText : result.error) : account.baseURL}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {editing ? (
            <div className="space-y-3">
              <Field label="显示名称">
                <Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="类型">
                  <SimpleSelect
                    value={editing.type}
                    onValueChange={(value) => setEditing({ ...editing, type: value })}
                    options={[
                      { value: "newapi", label: "NewAPI" },
                      { value: "sub2api", label: "Sub2API" },
                    ]}
                  />
                </Field>
                <Field label="用户 ID" hint="NewAPI 可选">
                  <Input value={editing.userId || ""} onChange={(event) => setEditing({ ...editing, userId: event.target.value })} />
                </Field>
              </div>
              <Field label="站点 / Base URL">
                <Input
                  value={editing.baseURL || ""}
                  onChange={(event) => setEditing({ ...editing, baseURL: event.target.value })}
                  placeholder="https://api.example.com"
                />
              </Field>
              <Field label="API Key">
                <Input type="password" value={editing.apiKey} onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })} />
              </Field>
              <Field label="访问令牌" hint="NewAPI 后台令牌或 Sub2API JWT">
                <Input
                  type="password"
                  value={editing.accessToken || ""}
                  onChange={(event) => setEditing({ ...editing, accessToken: event.target.value })}
                />
              </Field>
              <Field label="自定义余额接口" hint="可留空使用兼容接口探测">
                <Input
                  value={editing.balanceEndpoint || ""}
                  onChange={(event) => setEditing({ ...editing, balanceEndpoint: event.target.value })}
                  placeholder="/api/user/self"
                />
              </Field>
              <div className="studio-subtle-surface flex items-center justify-between rounded-lg border border-black/5 px-3 py-2">
                <span className="text-sm text-[#666]">启用余额查询</span>
                <Switch checked={editing.enabled !== false} onCheckedChange={(enabled) => setEditing({ ...editing, enabled })} />
              </div>
              <div className="flex justify-between pt-1">
                <Button variant="ghost" disabled={saving} onClick={() => void remove(editing.id)}>
                  <Trash2 className="h-4 w-4" /> 删除
                </Button>
                <Button disabled={saving} onClick={() => void save()}>
                  <Save className="h-4 w-4" /> 保存账户
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center text-center text-[#999]">
              <Coins className="mb-2 h-6 w-6" />
              <p className="text-sm">选择账户编辑，或添加一个余额账户</p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={probing || accounts.length === 0} onClick={() => void onProbe()}>
            <Coins className="h-4 w-4" /> {probing ? "查询中" : "刷新全部余额"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
