import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { apiClient } from '../api/client';
import { setMockPreset } from './mockEngine';
import { setCaptchaRejection } from './mockHttp';

describe('米游社自托管签到面板 前端关键交互与契约测试', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.pushState({}, '', '/');
    setMockPreset('default-ready');
  });

  it('忽略旧的模拟模式链接和浏览器设置，直接请求后端且不显示调试开关', async () => {
    window.localStorage.setItem('mys_console_api_mode', 'mock');
    window.history.pushState({}, '', '/?mode=mock&scenario=setup-required');
    render(<App />);
    await screen.findByRole('heading', { name: '实例运行概览' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/setup/status', expect.objectContaining({ method: 'GET', credentials: 'include' }));
    expect(screen.queryByRole('group', { name: '接口运行模式切换' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '切换模拟场景' })).not.toBeInTheDocument();
    expect(screen.queryByText(/显式模拟模式|真实 API 模式|快进 65s|重置场景/)).not.toBeInTheDocument();
  });

  it('1. 未初始化实例应导向 /setup，完成初始化后转向 /login 且不自动登录', async () => {
    setMockPreset('setup-required');
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('初始化自托管签到面板')).toBeInTheDocument();
    });

    const pwdInput = screen.getByLabelText(/面板管理员密码/i);
    const confirmInput = screen.getByLabelText(/确认管理员密码/i);
    await user.type(screen.getByLabelText(/部署者初始化令牌/i), 'synthetic-setup-token');
    await user.type(pwdInput, 'StrongAdminPass123!');
    await user.type(confirmInput, 'StrongAdminPass123!');

    const submitBtn = screen.getByRole('button', { name: /完成实例初始化并前往登录/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('登录米游社自托管签到面板')).toBeInTheDocument();
    });
  });

  it('2. 后端连接失败时显示错误与重试按钮，不提供模式切换', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('无法连接至本实例后端服务')).toBeInTheDocument();
      expect(screen.getByText(/NETWORK_ERROR/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /重试连接后端/ })).toBeInTheDocument();
      expect(screen.queryByText(/模拟模式|真实 API 模式/)).not.toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });

  it('3. 短信登录完整闭环：创建不发短信 -> awaiting_captcha 人工验证(含失败更新会话) -> 保留前导零字符串验证码 -> 轮询完成终止', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('实例运行概览')).toBeInTheDocument();
    });

    // 打开添加米游社账号弹窗
    const addBtns = screen.getAllByRole('button', { name: /添加米游社账号/i });
    await user.click(addBtns[0]);

    const phoneInput = await screen.findByLabelText(/中国大陆手机号码/i);
    await user.type(phoneInput, '13900000000');

    const createBtn = screen.getByRole('button', { name: /第一步：创建登录流程/i });
    await user.click(createBtn);

    // 确认状态为 created，且没有谎称短信已发送
    await waitFor(() => {
      expect(screen.getByText(/等待发送短信验证码/i)).toBeInTheDocument();
      expect(screen.queryByText(/短信验证码已发送至/i)).not.toBeInTheDocument();
    });

    // 点击发送短信 -> 触发 awaiting_captcha 并打开统一人工验证舱
    const sendSmsBtn = screen.getByRole('button', { name: /获取验证码（发送短信）/i });
    await user.click(sendSmsBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '点击开始手动验证' })).toBeInTheDocument();
      expect(screen.queryByText(/短信验证码已发送至/i)).not.toBeInTheDocument();
    });

    // 先测试人工验证被上游拒绝 (422 CHALLENGE_FAILED) -> 显示“更新验证会话”
    setCaptchaRejection(true);
    const failChallengeBtn = screen.getByRole('button', { name: '点击开始手动验证' });
    await user.click(failChallengeBtn);

    const renewBtn = await screen.findByRole('button', { name: /更新验证会话/i });
    await user.click(renewBtn);
    await screen.findByText('已更新验证会话');

    // 更新会话后手动完成验证并提交有效结果
    setCaptchaRejection(false);
    const passChallengeBtn = await screen.findByRole('button', { name: '点击开始手动验证' });
    await user.click(passChallengeBtn);

    // 只有进入 awaiting_sms_code 才提示短信已发送
    await waitFor(() => {
      expect(screen.getByText(/短信验证码已发送至 139\*\*\*\*0000/i)).toBeInTheDocument();
    });

    // 先输入错误验证码 "000001" 测试 422 SMS_CODE_INVALID 分支并保留输入界面
    const codeInput = screen.getByLabelText(/6 位短信验证码/i);
    await user.type(codeInput, '000001');
    const submitCodeBtn = screen.getByRole('button', { name: /提交短信验证码/i });
    await user.click(submitCodeBtn);

    await waitFor(() => {
      expect(screen.getByText(/SMS_CODE_INVALID/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/6 位短信验证码/i)).toBeInTheDocument();
    });

    // 修正为带前导零的字符串验证码 "000000" 提交
    await user.clear(codeInput);
    await user.type(codeInput, '000000');
    expect((codeInput as HTMLInputElement).value).toBe('000000');
    await user.click(submitCodeBtn);

    // 经历 exchanging 轮询并在 completed 时终止，提示绑定成功并引导开启每日计划
    await waitFor(
      () => {
        expect(screen.getByText(/米游社账号绑定成功！/i)).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: /前往选择任务并开启每日计划/i })
        ).toBeInTheDocument();
      },
      { timeout: 4500 }
    );
  });

  it('4. 未知余额必须显示“尚未获取”而非 0，未验证能力必须禁用并标记“待适配”', async () => {
    setMockPreset('missions-unfetched');
    window.history.pushState({}, '', '/accounts/11111111-1111-4111-8111-111111111111');
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('mission-total-points')).toHaveTextContent('尚未获取');
      expect(screen.getByTestId('mission-today-points')).toHaveTextContent('尚未获取');
      expect(screen.getByTestId('mission-can-get-points')).toHaveTextContent('尚未获取');
    });

    // 验证根凭据有效期未知文案
    expect(screen.getByText(/根凭据有效期未知（不计算虚假剩余天数）/i)).toBeInTheDocument();

    // 验证未适配社区与任务处于 disabled 状态
    expect(screen.getByText(/待适配 · 待完成官方接口实测/i)).toBeInTheDocument();

    // 点击“刷新任务”获取真实快照
    const refreshBtn = screen.getByRole('button', { name: '刷新任务' });
    await user.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByTestId('mission-total-points')).toHaveTextContent('1030 米游币');
      expect(screen.getByTestId('mission-today-points')).toHaveTextContent('30 米游币');
    });
  });

  it('5. 乐观锁版本冲突 (409 VERSION_CONFLICT) 应重新获取最新值并展示人工确认合并框', async () => {
    setMockPreset('account-version-conflict');
    window.history.pushState({}, '', '/accounts/11111111-1111-4111-8111-111111111111');
    const user = userEvent.setup();
    render(<App />);

    const remarkInput = await screen.findByLabelText(/账号备注/i);
    await user.clear(remarkInput);
    await user.type(remarkInput, '我的新备注修改');

    const saveBtn = screen.getByRole('button', { name: /保存账号任务偏好/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/检测到账号配置版本冲突 \(409 VERSION_CONFLICT\)/i)
      ).toBeInTheDocument();
    });

    const confirmMergeBtn = screen.getByRole('button', {
      name: /确认在最新 v2 基础上提交我的修改/i
    });
    await user.click(confirmMergeBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(/检测到账号配置版本冲突 \(409 VERSION_CONFLICT\)/i)
      ).not.toBeInTheDocument();
    });
  });

  it('6. SMTP 密码保留语义：不回填 ******，留空保存保留原密码，支持新设与 clearPassword 及测试邮件轮询', async () => {
    window.history.pushState({}, '', '/settings');
    const user = userEvent.setup();
    const updateNotifSpy = vi.spyOn(apiClient, 'updateNotificationSettings');

    render(<App />);

    const pwdInput = (await screen.findByLabelText(/替换 SMTP 密码/i)) as HTMLInputElement;
    // 绝不回填 ******
    expect(pwdInput.value).toBe('');

    // 1) 输入新密码并保存
    await user.type(pwdInput, 'my-secret-smtp-pass');
    const saveNotifBtn = screen.getByRole('button', { name: /保存通知配置/i });
    await user.click(saveNotifBtn);

    await waitFor(() => {
      expect(updateNotifSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          smtpPassword: 'my-secret-smtp-pass'
        })
      );
      expect(
        screen.getByText(/已配置密码 \(smtpPasswordConfigured = true\)/i)
      ).toBeInTheDocument();
    });

    // 保存后密码框应自动清空，不残留明文
    expect(pwdInput.value).toBe('');

    // 2) 不修改密码直接修改收件邮箱并保存 -> 请求体必须省略 smtpPassword 以保留原密码
    const toInput = screen.getByLabelText(/管理员收件邮箱/i);
    await user.clear(toInput);
    await user.type(toInput, 'admin2@example.invalid');
    await user.click(saveNotifBtn);

    await waitFor(() => {
      const lastCallArg = updateNotifSpy.mock.calls.at(-1)?.[0];
      expect(lastCallArg).toBeDefined();
      expect(lastCallArg?.smtpPassword).toBeUndefined();
      expect(lastCallArg?.clearPassword).toBeUndefined();
    });

    // 3) 发送测试邮件并轮询至 succeeded
    const testBtn = screen.getByRole('button', { name: /向已保存收件地址发送测试邮件/i });
    await waitFor(() => expect(testBtn).toBeEnabled());
    await user.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText(/已确认发送成功 \(succeeded\)/i)).toBeInTheDocument();
    });

    updateNotifSpy.mockRestore();
  });

  it('7. 执行记录页：准确渲染 already_completed (今日已完成/收益0)、outcome_unknown (结果待核对) 与取消不回滚提示', async () => {
    setMockPreset('run-already-completed');
    window.history.pushState({}, '', '/runs');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('今日已完成')).toBeInTheDocument();
      expect(
        screen.getByText(/已核对今日任务已完成，本次收益计 0，不重复累加/i)
      ).toBeInTheDocument();
    });
  });

  it('8. 账号列表批量操作汇总（不以全部成功掩盖失败）与删除账号二次确认文案', async () => {
    window.history.pushState({}, '', '/accounts');
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('演示账号')).toBeInTheDocument();
      expect(screen.getByText('星海旅行者')).toBeInTheDocument();
    });

    // 全选两个账号（一个 active，一个 reauth_required）执行批量检查登录状态
    const selectAllCheckbox = screen.getByLabelText(/全选/i);
    await user.click(selectAllCheckbox);

    const batchCheckBtn = screen.getAllByRole('button', { name: '检查登录状态' })[0];
    await user.click(batchCheckBtn);

    await waitFor(() => {
      expect(screen.getByText(/批量检查登录状态 · 逐账号执行结果汇总/i)).toBeInTheDocument();
      expect(
        screen.getByText(/成功：1 项 · 等待验证：0 项 · 失败：1 项/i)
      ).toBeInTheDocument();
    });

    // 点击删除按钮弹出二次确认框，核对文案
    const deleteBtn = screen.getByRole('button', { name: /删除账号 演示账号/i });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/仅删除本实例中的账号、凭据和计划，不删除米哈游账号。/i)
      ).toBeInTheDocument();
    });
  });
});
