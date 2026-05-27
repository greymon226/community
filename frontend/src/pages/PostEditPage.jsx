import { useEffect, useState, useMemo } from 'react';
import { Card, Form, Input, Button, Cascader, Space, Tag, App, Radio, Modal, List, Typography, Spin, Alert } from 'antd';
import { RobotOutlined, BulbOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import RichEditor from '../components/RichEditor.jsx';
import { categoryApi, postApi, aiApi } from '../api';
import { useAuthStore } from '../store/auth.js';

export default function PostEditPage() {
  const { id } = useParams();
  const editing = !!id;
  const [form] = Form.useForm();
  const [tree, setTree] = useState([]);
  const [content, setContent] = useState('');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // AI 助手
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistMode, setAssistMode] = useState(null); // 'title' | 'summary' | 'explainCode'
  const [assistLoading, setAssistLoading] = useState(false);
  const [assistResult, setAssistResult] = useState(null);
  const [codeInput, setCodeInput] = useState('');
  const { message } = App.useApp();
  const nav = useNavigate();
  const { token } = useAuthStore();

  useEffect(() => {
    if (!token) {
      message.warning('请先登录');
      nav('/login');
      return;
    }
    categoryApi.tree().then(setTree);
    if (editing) {
      postApi.detail(id).then((p) => {
        form.setFieldsValue({
          title: p.title,
          categoryPath: findPath(tree, p.categoryId),
          status: p.status === 'draft' ? 'draft' : 'published',
        });
        setContent(p.content);
        setTags(p.tags?.map((t) => t.name) || []);
      });
    } else {
      // 来自 AI 问答"发帖求助"的预填
      const draftTitle = sessionStorage.getItem('post-draft-title');
      if (draftTitle) {
        form.setFieldsValue({ title: draftTitle });
        sessionStorage.removeItem('post-draft-title');
      }
    }
  }, [id]);

  const cascaderOptions = useMemo(() => mapToCascader(tree), [tree]);

  const onFinish = async (values) => {
    if (!content || content.trim() === '<br>' || content.trim() === '') {
      message.warning('请输入正文');
      return;
    }
    const categoryId = values.categoryPath?.[values.categoryPath.length - 1];
    if (!categoryId) {
      message.warning('请选择分类');
      return;
    }
    setSubmitting(true);
    try {
      const payload = { title: values.title, content, categoryId, tags, status: values.status };
      const result = editing ? await postApi.update(id, payload) : await postApi.create(payload);
      // 后端可能返回 pending=true（AI 审核存疑）
      if (result.pending) {
        message.warning('已提交，AI 审核存疑，等待管理员复审');
      } else if (result.status === 'draft') {
        message.success('已保存为草稿');
      } else {
        message.success(editing ? '已更新' : '发布成功');
      }
      nav(`/post/${result.id}`);
    } catch (e) {
      // 错误提示已由 axios 拦截器统一展示，这里不再二次 toast
    } finally {
      setSubmitting(false);
    }
  };

  const addTag = (v) => {
    const t = (v || tagInput).trim();
    if (t && !tags.includes(t) && tags.length < 10) setTags([...tags, t]);
    setTagInput('');
  };

  // ===== AI 助手 =====
  const openAssist = (kind) => {
    setAssistMode(kind);
    setAssistResult(null);
    setCodeInput('');
    setAssistOpen(true);
    if (kind !== 'explainCode') runAssist(kind);
  };

  const runAssist = async (kind = assistMode, extra = {}) => {
    if (!kind) return;
    setAssistLoading(true);
    try {
      const title = form.getFieldValue('title') || '';
      let payload;
      if (kind === 'title') payload = { title, content };
      else if (kind === 'summary') payload = { title, content };
      else if (kind === 'explainCode') payload = { snippet: extra.snippet || codeInput, language: extra.language || '' };

      const r = await aiApi.assist(kind, payload);
      setAssistResult(r);
    } catch (e) {
      // 错误已被 axios 拦截器 toast
    } finally {
      setAssistLoading(false);
    }
  };

  const applyTitle = (t) => {
    form.setFieldsValue({ title: t });
    setAssistOpen(false);
    message.success('已应用标题');
  };

  const renderAssist = () => {
    if (assistLoading && !assistResult) {
      return <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="生成中..." /></div>;
    }
    if (!assistResult && assistMode !== 'explainCode') return null;

    if (assistMode === 'title') {
      return (
        <List
          header={<Typography.Text type="secondary">点击候选可一键替换标题</Typography.Text>}
          dataSource={assistResult?.suggestions || []}
          renderItem={(s) => (
            <List.Item
              actions={[<Button type="link" onClick={() => applyTitle(s)}>使用</Button>]}
            >{s}</List.Item>
          )}
        />
      );
    }

    if (assistMode === 'summary') {
      return (
        <Alert
          type="success"
          message="生成的摘要"
          description={assistResult?.summary || '（空）'}
          style={{ whiteSpace: 'pre-wrap' }}
        />
      );
    }

    if (assistMode === 'explainCode') {
      return (
        <>
          <Input.TextArea
            rows={8}
            placeholder="把要解释的代码粘贴到这里"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            style={{ marginBottom: 12, fontFamily: 'Menlo, Consolas, monospace' }}
          />
          <Button
            type="primary"
            loading={assistLoading}
            disabled={!codeInput.trim()}
            onClick={() => runAssist('explainCode', { snippet: codeInput })}
          >
            解释这段代码
          </Button>
          {assistResult && (
            <div style={{ marginTop: 16 }}>
              <Typography.Title level={5}>解释</Typography.Title>
              <Typography.Paragraph>{assistResult.explanation}</Typography.Paragraph>
              {assistResult.risks?.length > 0 && (
                <>
                  <Typography.Title level={5}>潜在问题</Typography.Title>
                  <ul style={{ paddingLeft: 20 }}>
                    {assistResult.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </>
              )}
              {assistResult.suggestions?.length > 0 && (
                <>
                  <Typography.Title level={5}>建议</Typography.Title>
                  <ul style={{ paddingLeft: 20 }}>
                    {assistResult.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      );
    }

    return null;
  };

  const assistTitleText = {
    title: 'AI 改写标题',
    summary: 'AI 生成摘要',
    explainCode: 'AI 解释代码',
  }[assistMode] || 'AI 助手';

  return (
    <Card
      title={editing ? '编辑帖子' : '发布新帖'}
      extra={
        <Space>
          <Button icon={<BulbOutlined />} onClick={() => openAssist('title')}>改写标题</Button>
          <Button icon={<FileTextOutlined />} onClick={() => openAssist('summary')}>生成摘要</Button>
          <Button icon={<CodeOutlined />} onClick={() => openAssist('explainCode')}>解释代码</Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ status: 'published' }}>
        <Form.Item label="标题" name="title" rules={[{ required: true, message: '请输入标题' }, { max: 200 }]}>
          <Input placeholder="一句话讲清楚你的想法" size="large" />
        </Form.Item>
        <Form.Item label="分类" name="categoryPath" rules={[{ required: true, message: '请选择分类' }]}>
          <Cascader options={cascaderOptions} placeholder="选择分类" changeOnSelect />
        </Form.Item>
        <Form.Item label="正文" required>
          <RichEditor value={content} onChange={setContent} />
        </Form.Item>
        <Form.Item label="标签 (回车添加，最多 10 个)">
          <Space wrap>
            {tags.map((t) => (
              <Tag closable key={t} onClose={() => setTags(tags.filter((x) => x !== t))}>{t}</Tag>
            ))}
            <Input
              size="small"
              style={{ width: 120 }}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onPressEnter={(e) => { e.preventDefault(); addTag(); }}
              placeholder="新增标签"
            />
          </Space>
        </Form.Item>
        <Form.Item label="状态" name="status">
          <Radio.Group>
            <Radio.Button value="published">发布</Radio.Button>
            <Radio.Button value="draft">存为草稿</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting} size="large">
          {editing ? '保存' : '发布'}
        </Button>
      </Form>

      <Modal
        title={<Space><RobotOutlined /> {assistTitleText}</Space>}
        open={assistOpen}
        onCancel={() => setAssistOpen(false)}
        footer={null}
        width={640}
        destroyOnClose
      >
        {renderAssist()}
      </Modal>
    </Card>
  );
}

function mapToCascader(list) {
  return list.map((c) => ({
    value: c.id,
    label: c.name,
    children: c.children?.length ? mapToCascader(c.children) : undefined,
  }));
}

function findPath(tree, id) {
  for (const node of tree) {
    if (node.id === id) return [node.id];
    const sub = findPath(node.children || [], id);
    if (sub) return [node.id, ...sub];
  }
  return null;
}
