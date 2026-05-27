import { useRef, useState } from 'react';
import { Drawer, Input, Button, Space, Spin, Alert, Card, Typography, List, Empty, Tag, App } from 'antd';
import { RobotOutlined, ReloadOutlined, EditOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { aiApi } from '../api';
import { useAuthStore } from '../store/auth.js';

/**
 * AI 站内问答抽屉（流式版）
 * - SSE：meta -> 多个 delta -> done | error
 * - 显示打字机效果，显著提升 TTFB 体感
 */
export default function AskAiDrawer({ open, onClose, initialQuestion = '' }) {
  const nav = useNavigate();
  const { token } = useAuthStore();
  const { message } = App.useApp();

  const [question, setQuestion] = useState(initialQuestion);
  const [streaming, setStreaming] = useState(false);
  const [meta, setMeta] = useState(null); // { candidates, quotaUsed, quotaLimit }
  const [answer, setAnswer] = useState('');
  const [done, setDone] = useState(null); // { hasAnswer, citations, usage, full }
  const abortRef = useRef(null);

  const reset = () => {
    setMeta(null);
    setAnswer('');
    setDone(null);
  };

  const submit = async () => {
    const q = question.trim();
    if (!q) return;
    if (streaming) return;

    reset();
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch('/api/ai/ask/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: q, topN: 5 }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        let msg = txt;
        try { msg = JSON.parse(txt).message || txt; } catch {}
        message.error(msg || `请求失败 (${resp.status})`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 帧以 \n\n 分隔
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!raw.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(raw.slice(5).trim()); } catch { continue; }

          if (evt.type === 'meta') {
            setMeta(evt.payload);
          } else if (evt.type === 'delta') {
            setAnswer((s) => s + (evt.payload?.text || ''));
          } else if (evt.type === 'done') {
            setDone(evt.payload);
          } else if (evt.type === 'error') {
            message.error(evt.payload?.message || 'AI 调用失败');
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        message.error(e.message || '网络异常');
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    if (abortRef.current) abortRef.current.abort();
  };

  const goPublishWithDraft = () => {
    onClose();
    sessionStorage.setItem('post-draft-title', question.trim());
    nav('/post/new');
  };

  const renderBody = () => {
    if (streaming && !meta && !answer) {
      return (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin tip="正在检索站内帖子..." />
        </div>
      );
    }
    if (!meta && !answer) return null;

    const candidates = meta?.candidates || [];
    const hasNoSources = !streaming && candidates.length === 0;

    return (
      <>
        {meta && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {streaming ? '生成中…' : '已完成'}
            {typeof meta.quotaUsed === 'number'
              ? ` · 今日已用 ${meta.quotaUsed}/${meta.quotaLimit}`
              : ''}
            。AI 内容仅供参考，请结合原帖核对。
          </Typography.Paragraph>
        )}

        {answer && (
          <Card size="small" style={{ marginBottom: 12 }}>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
              {answer}
              {streaming && <span style={{ opacity: 0.5 }}>▌</span>}
            </Typography.Paragraph>
          </Card>
        )}

        {hasNoSources && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="站内还没有合适的答案"
            description="建议把问题发到对应板块求助，或换一个关键词再搜搜。"
            action={
              <Button size="small" type="primary" icon={<EditOutlined />} onClick={goPublishWithDraft}>
                发帖求助
              </Button>
            }
          />
        )}

        {done?.citations?.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 12 }}>引用的帖子</Typography.Title>
            <List
              size="small"
              dataSource={done.citations}
              renderItem={(c, i) => (
                <List.Item
                  actions={[
                    <Button type="link" size="small" onClick={() => { onClose(); nav(`/post/${c.id}`); }}>
                      查看原帖
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={<Space><Tag color="blue">{i + 1}</Tag>{c.title}</Space>}
                    description={
                      <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                        {c.author} · {c.category}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          </>
        )}

        {candidates.length > 0 && (
          <>
            <Typography.Title level={5} style={{ marginTop: 12 }}>相关讨论</Typography.Title>
            <List
              size="small"
              dataSource={candidates}
              renderItem={(c) => (
                <List.Item>
                  <a onClick={() => { onClose(); nav(`/post/${c.id}`); }}>{c.title}</a>
                  <span style={{ color: '#8c8c8c', fontSize: 12 }}>{c.category}</span>
                </List.Item>
              )}
            />
          </>
        )}

        {!streaming && !done && !meta && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无回答" />
        )}
      </>
    );
  };

  return (
    <Drawer
      title={<Space><RobotOutlined /> AI 站内问答</Space>}
      width={560}
      open={open}
      onClose={() => { stop(); onClose(); }}
      destroyOnClose
    >
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          placeholder="问点什么，比如：Vue3 响应式丢失怎么排查？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPressEnter={submit}
          allowClear
          disabled={streaming}
        />
        {streaming ? (
          <Button icon={<StopOutlined />} onClick={stop}>停止</Button>
        ) : (
          <>
            <Button type="primary" icon={<SendOutlined />} onClick={submit}>提问</Button>
            {(answer || done) && (
              <Button icon={<ReloadOutlined />} onClick={submit} title="重新生成" />
            )}
          </>
        )}
      </Space.Compact>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        AI 会先在站内检索相关帖子，再边检索边流式生成回答；找不到时会引导你发帖求助。
      </Typography.Paragraph>

      {renderBody()}
    </Drawer>
  );
}
