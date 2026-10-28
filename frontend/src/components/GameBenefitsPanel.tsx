import { useEffect, useRef, useState } from 'react';
import { Gift, RefreshCw, Play, Save } from 'lucide-react';
import { apiClient } from '../api/client';
import type { GameRolesSnapshot } from '../types/openapi';
import { formatShanghaiDateTime } from '../utils/format';

type Props = {
  accountId: string; enabled: boolean; selectedIds: string[]; busy: boolean;
  onEnabledChange: (enabled: boolean) => void; onSelectionChange: (ids: string[]) => void;
  onSave: () => void; onSign: () => void;
};
const labels = { signed: '今日已签到', not_signed: '今日未签到', unknown: '状态待查询', unavailable: '暂未适配' };

export function GameBenefitsPanel({ accountId, enabled, selectedIds, busy, onEnabledChange, onSelectionChange, onSave, onSign }: Props) {
  const [snapshot, setSnapshot] = useState<GameRolesSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null); setError(''); setRefreshing(false);
    void apiClient.getGameRoles(accountId).then(res => { if (current === generation.current) setSnapshot(res.data); })
      .catch(err => { if (current === generation.current) setError(err instanceof Error ? err.message : '读取角色失败'); });
    return () => { generation.current++; };
  }, [accountId]);
  const refresh = async () => {
    if (refreshing) return;
    const current = generation.current; setRefreshing(true); setError('');
    try { const result = await apiClient.refreshGameRoles(accountId); if (current === generation.current) setSnapshot(result.data); }
    catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : '刷新角色失败'); }
    finally { if (current === generation.current) setRefreshing(false); }
  };
  const roles = snapshot?.roles ?? [], all = selectedIds.length === 0;
  const executable = roles.filter(r => r.executable);
  const toggle = (key: string) => {
    const current = all ? executable.map(r => r.id) : selectedIds;
    const next = current.includes(key) ? current.filter(id => id !== key) : [...current, key];
    if (next.length) onSelectionChange(next);
  };
  return <section className="panel-card mb-6" id="game-benefits" aria-labelledby="game-benefits-title">
    <div className="panel-header">
      <div><h2 className="panel-title" id="game-benefits-title"><Gift size={18} /> 签到福利 · 游戏奖励</h2>
        <p className="panel-desc">原神、星穹铁道、绝区零等游戏的每日签到福利。奖励按游戏角色记录，可与米游币签到同时执行。</p></div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />{refreshing ? '正在查询角色…' : '刷新游戏角色'}</button>
    </div>
    {error && <div className="alert-banner alert-danger mb-3" role="alert">{error}</div>}
    <div className="form-stack mb-4">
      <label className="checkbox-inline"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => onEnabledChange(e.target.checked)} />启用签到福利（加入立即执行与每日计划）</label>
      <label className="checkbox-inline"><input type="checkbox" checked={all} disabled={busy || !enabled || executable.length === 0} onChange={e => onSelectionChange(e.target.checked ? [] : executable.map(r => r.id))} />全部绑定角色（自动包含以后新增的角色）</label>
    </div>
    {roles.length > 0 ? <div className="table-wrap mb-4"><table className="data-table">
      <thead><tr><th>选择</th><th>游戏 / 角色</th><th>今日状态</th><th>累计签到</th><th>本日奖励</th></tr></thead>
      <tbody>{roles.map(role => <tr key={role.id}>
        <td><input type="checkbox" aria-label={`选择${role.gameName}角色${role.uid}`} checked={role.executable && (all || selectedIds.includes(role.id))} disabled={busy || !enabled || !role.executable || (!all && selectedIds.length === 1 && selectedIds.includes(role.id))} onChange={() => toggle(role.id)} /></td>
        <td><strong>{role.gameName} · {role.nickname}</strong><div className="text-xs text-muted">{role.uid} / {role.regionName}</div>{role.blockedReason && <div className="text-xs text-muted">{role.blockedReason}</div>}</td>
        <td><span className={`badge ${role.status === 'signed' ? 'badge-jade' : 'badge-slate'}`}>{labels[role.status]}</span></td>
        <td>{role.totalSignDays === null ? '—' : `${role.totalSignDays} 天`}</td>
        <td>{role.reward ? `${role.reward.name} × ${role.reward.count}` : '—'}</td>
      </tr>)}</tbody>
    </table></div> : <p className="text-muted mb-4">点击“刷新游戏角色”读取官方绑定列表；查询角色不会执行签到。</p>}
    <p className="text-xs text-muted mb-4">查询时间：{formatShanghaiDateTime(snapshot?.fetchedAt ?? null)}{snapshot?.stale ? '（快照可能已过期）' : ''}。本日奖励为官方签到奖励记录；已签到的角色不会重复领取或累加本次收益。</p>
    <div className="button-row">
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onSave}><Save size={14} />保存签到设置</button>
      <button type="button" className="btn btn-primary" disabled={busy || !enabled} onClick={onSign}><Play size={14} />保存并立即签到福利</button>
    </div>
    <p className="text-xs text-muted mt-3">需要每日自动签到时，请在下方开启该账号的每日计划。遇到人机验证会暂停，等待你手动完成。</p>
  </section>;
}
