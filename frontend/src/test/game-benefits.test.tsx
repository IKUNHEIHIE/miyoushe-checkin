import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { apiClient } from '../api/client';
import { setMockPreset } from './mockEngine';
import { GameBenefitsPanel } from '../components/GameBenefitsPanel';
import type { GameRolesSnapshot, SuccessEnvelope } from '../types/openapi';

describe('签到福利', () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); setMockPreset('default-ready'); });
  it('选择游戏角色后保存并签到，展示游戏奖励而非米游币', async () => {
    window.history.pushState({}, '', '/accounts/11111111-1111-4111-8111-111111111111');
    const user = userEvent.setup(), create = vi.spyOn(apiClient, 'createAccountRun');
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '刷新游戏角色' }));
    await screen.findByText('原神 · 演示角色1');
    await user.click(screen.getByRole('checkbox', { name: '启用签到福利（加入立即执行与每日计划）' }));
    await user.click(screen.getByRole('checkbox', { name: '选择崩坏：星穹铁道角色100000011' }));
    await user.click(screen.getByRole('button', { name: '保存并立即签到福利' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { communityIds: [], taskKinds: ['game_sign'], gameRoleIds: ['game_synthetic_0', 'game_synthetic_2'] }));
    await screen.findByRole('heading', { name: '步骤执行明细 (2)' });
    await screen.findByText('甜甜花酿鸡 × 3');
    expect(screen.getByText('正式调查员记录 × 3')).toBeInTheDocument();
    expect(screen.queryByText('罐装快乐水 × 3')).not.toBeInTheDocument();
    create.mockRestore();
  });

  it('切换账号后忽略旧账号延迟返回的角色快照', async () => {
    let resolveOld!: (value: SuccessEnvelope<GameRolesSnapshot>) => void;
    const getter = vi.spyOn(apiClient, 'getGameRoles').mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ data: { accountId: 'account-b', fetchedAt: null, stale: true, roles: [] }, requestId: 'synthetic' });
    const props = { enabled: true, selectedIds: [], busy: false, onEnabledChange: vi.fn(), onSelectionChange: vi.fn(), onSave: vi.fn(), onSign: vi.fn() };
    const view = render(<GameBenefitsPanel {...props} accountId="account-a" />);
    view.rerender(<GameBenefitsPanel {...props} accountId="account-b" />);
    await act(async () => { resolveOld({ data: { accountId: 'account-a', fetchedAt: null, stale: false, roles: [{ id: 'old-role', gameBiz: 'hk4e_cn', gameName: '旧账号游戏', uid: '100000000', region: 'cn_gf01', regionName: '天空岛', nickname: '旧账号私有角色', level: 60, communityId: 2, executable: true, blockedReason: null, status: 'signed', totalSignDays: 5, reward: null, lastCheckedAt: null }] }, requestId: 'synthetic' }); });
    expect(screen.queryByText(/旧账号私有角色/)).not.toBeInTheDocument();
    getter.mockRestore();
  });
});
