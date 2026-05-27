import { useEffect, useState } from 'react';
import {
  Card, Tabs, Statistic, Row, Col, Table, Tag, Button, Space, Input, Select, Modal, Form, App, Popconfirm, Switch, InputNumber,
} from 'antd';
import dayjs from 'dayjs';
import { adminApi, categoryApi, reportApi } from '../api';
import { useAuthStore } from '../store/auth.js';
import { useNavigate } from 'react-router-dom';

export default function AdminPage() {
  const { user } = useAuthStore();
  const nav = useNavigate();
  const [active, setActive] = useState('overview');

  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    return <Card>无访问权限</Card>;
  }

  const tabs = [
    { key: 'overview', label: '总览', children: <Overview /> },
    { key: 'reports', label: '举报处理', children: <Reports /> },
    ...(user.role === 'admin' ? [
      { key: 'categories', label: '板块管理', children: <Categories /> },
      { key: 'users', label: '用户与权限', children: <Users /> },
      { key: 'words', label: '敏感词', children: <SensitiveWords /> },
      { key: 'settings', label: '系统设置', children: <Settings /> },
      { key: 'audits', label: '审计日志', children: <AuditLogs /> },
    ] : []),
  ];

  return (
    <Card title="管理后台" extra={<Button onClick={() => nav('/')}>返回首页</Button>}>
      <Tabs activeKey={active} onChange={setActive} items={tabs} destroyInactiveTabPane />
    </Card>
  );
}

function Overview() {
  const [data, setData] = useState(null);
  useEffect(() => { adminApi.stats().then(setData); }, []);
  if (!data) return null;
  return (
    <Row gutter={16}>
      <Col span={6}><Card><Statistic title="用户总数" value={data.users} /></Card></Col>
      <Col span={6}><Card><Statistic title="帖子总数" value={data.posts} /></Card></Col>
      <Col span={6}><Card><Statistic title="评论总数" value={data.comments} /></Card></Col>
      <Col span={6}><Card><Statistic title="待处理举报" value={data.pendingReports} valueStyle={{ color: '#cf1322' }} /></Card></Col>
    </Row>
  );
}

function Reports() {
  const [data, setData] = useState({ items: [] });
  const [status, setStatus] = useState('pending');
  const { message } = App.useApp();
  const load = () => reportApi.list({ status }).then(setData);
  useEffect(() => { load(); }, [status]);
  const handle = async (id, action) => {
    await reportApi.handle(id, { action });
    message.success('已处理');
    load();
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select value={status} style={{ width: 160 }} onChange={setStatus} options={[
          { value: 'pending', label: '待处理' },
          { value: 'resolved', label: '已处理' },
          { value: 'rejected', label: '已驳回' },
          { value: 'all', label: '全部' },
        ]} />
      </Space>
      <Table
        rowKey="id"
        dataSource={data.items}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: '类型', dataIndex: 'targetType' },
          { title: '目标 ID', dataIndex: 'targetId' },
          { title: '理由', dataIndex: 'reason' },
          { title: '状态', dataIndex: 'status', render: (v) => <Tag>{v}</Tag> },
          { title: '时间', dataIndex: 'createdAt', render: (v) => dayjs(v).format('YY-MM-DD HH:mm') },
          {
            title: '操作',
            render: (_, r) =>
              r.status === 'pending' && (
                <Space>
                  <Button danger size="small" onClick={() => handle(r.id, 'block')}>屏蔽内容</Button>
                  <Button size="small" onClick={() => handle(r.id, 'reject')}>驳回</Button>
                </Space>
              ),
          },
        ]}
      />
    </>
  );
}

function Categories() {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const { message } = App.useApp();

  const flat = (nodes, level = 0) =>
    nodes.flatMap((n) => [{ ...n, level }, ...flat(n.children || [], level + 1)]);

  const load = () => categoryApi.tree().then((t) => setList(flat(t)));
  useEffect(() => { load(); }, []);

  const onSave = async (values) => {
    if (editing) await categoryApi.update(editing.id, values);
    else await categoryApi.create(values);
    setOpen(false);
    setEditing(null);
    form.resetFields();
    message.success('已保存');
    load();
  };

  const onAdd = () => { setEditing(null); form.resetFields(); setOpen(true); };
  const onEdit = (r) => { setEditing(r); form.setFieldsValue(r); setOpen(true); };
  const onDelete = async (r) => { await categoryApi.remove(r.id); message.success('已删除'); load(); };

  return (
    <>
      <Button type="primary" onClick={onAdd} style={{ marginBottom: 12 }}>新建板块</Button>
      <Table
        rowKey="id"
        dataSource={list}
        columns={[
          { title: '名称', dataIndex: 'name', render: (v, r) => '— '.repeat(r.level) + v },
          { title: '描述', dataIndex: 'description', ellipsis: true },
          { title: '排序', dataIndex: 'sort', width: 80 },
          { title: '启用', dataIndex: 'enabled', render: (v) => <Tag color={v ? 'green' : 'red'}>{v ? '是' : '否'}</Tag> },
          {
            title: '操作',
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => onEdit(r)}>编辑</Button>
                <Popconfirm title="确认删除？" onConfirm={() => onDelete(r)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing ? '编辑板块' : '新建板块'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="父级 ID" name="parentId"><Input placeholder="顶级留空" /></Form.Item>
          <Form.Item label="描述" name="description"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item label="排序" name="sort"><Input type="number" /></Form.Item>
          <Form.Item label="图标 URL" name="icon"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function Users() {
  const [data, setData] = useState({ items: [] });
  const [keyword, setKeyword] = useState('');
  const { message } = App.useApp();
  const load = () => adminApi.users({ keyword }).then(setData);
  useEffect(() => { load(); }, [keyword]);
  const updateRole = async (u, role) => {
    await adminApi.updateUserRole(u.id, { role });
    message.success('已更新');
    load();
  };
  const updateStatus = async (u, status) => {
    await adminApi.updateUserRole(u.id, { status });
    message.success('已更新');
    load();
  };
  return (
    <>
      <Input.Search placeholder="搜索工号/姓名/部门" allowClear onSearch={setKeyword} style={{ width: 280, marginBottom: 12 }} />
      <Table
        rowKey="id"
        dataSource={data.items}
        columns={[
          { title: '工号', dataIndex: 'empNo' },
          { title: '姓名', dataIndex: 'name' },
          { title: '昵称', dataIndex: 'nickname' },
          { title: '部门', dataIndex: 'department' },
          {
            title: '角色',
            render: (_, r) => (
              <Select
                value={r.role}
                style={{ width: 120 }}
                onChange={(v) => updateRole(r, v)}
                options={[
                  { value: 'user', label: '普通用户' },
                  { value: 'moderator', label: '版主' },
                  { value: 'admin', label: '管理员' },
                ]}
              />
            ),
          },
          {
            title: '状态',
            render: (_, r) => (
              <Select
                value={r.status}
                style={{ width: 100 }}
                onChange={(v) => updateStatus(r, v)}
                options={[
                  { value: 'active', label: '正常' },
                  { value: 'disabled', label: '禁用' },
                ]}
              />
            ),
          },
        ]}
      />
    </>
  );
}

function SensitiveWords() {
  const [list, setList] = useState([]);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const load = () => adminApi.words().then(setList);
  useEffect(() => { load(); }, []);
  const add = async (v) => {
    await adminApi.addWord(v);
    message.success('已添加');
    form.resetFields();
    load();
  };
  return (
    <>
      <Form form={form} layout="inline" onFinish={add} style={{ marginBottom: 12 }}>
        <Form.Item name="word" rules={[{ required: true }]}><Input placeholder="新增敏感词" /></Form.Item>
        <Form.Item name="strategy" initialValue="mask">
          <Select style={{ width: 140 }} options={[
            { value: 'mask', label: '替换为 *' },
            { value: 'block', label: '禁止发布' },
            { value: 'review', label: '人工审核' },
          ]} />
        </Form.Item>
        <Button type="primary" htmlType="submit">添加</Button>
      </Form>
      <Table
        rowKey="id"
        dataSource={list}
        columns={[
          { title: '词', dataIndex: 'word' },
          { title: '策略', dataIndex: 'strategy' },
          {
            title: '操作',
            render: (_, r) => (
              <Popconfirm title="删除？" onConfirm={async () => { await adminApi.deleteWord(r.id); load(); }}>
                <Button size="small" danger>删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </>
  );
}

function AuditLogs() {
  const [data, setData] = useState({ items: [] });
  useEffect(() => { adminApi.audits({ pageSize: 50 }).then(setData); }, []);
  return (
    <Table
      rowKey="id"
      dataSource={data.items}
      columns={[
        { title: '时间', dataIndex: 'createdAt', render: (v) => dayjs(v).format('YY-MM-DD HH:mm:ss'), width: 160 },
        { title: '操作人', render: (_, r) => r.operator?.nickname || r.operator?.name || '-' },
        { title: '动作', dataIndex: 'action' },
        { title: '对象', render: (_, r) => `${r.targetType || ''} #${r.targetId || ''}` },
        { title: '详情', dataIndex: 'detail', ellipsis: true },
        { title: 'IP', dataIndex: 'ip' },
      ]}
    />
  );
}

function Settings() {
  const [list, setList] = useState([]);
  const [aiStatus, setAiStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const { message } = App.useApp();

  const load = async () => {
    const data = await adminApi.settings();
    setList(data.items || []);
    setAiStatus(data.aiStatus || null);
  };
  useEffect(() => { load(); }, []);

  const update = async (key, value) => {
    setLoading(true);
    try {
      await adminApi.updateSetting(key, value);
      message.success('已保存');
      await load();
    } finally {
      setLoading(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await adminApi.testAi();
      setTestResult(r);
      message.success(`AI 调用成功（${r.elapsedMs}ms）`);
    } catch (e) {
      // http.js 已 toast 错误
    } finally {
      setTesting(false);
    }
  };

  const renderControl = (item) => {
    if (typeof item.value === 'boolean') {
      return (
        <Switch
          checked={item.value}
          loading={loading}
          onChange={(checked) => update(item.key, checked)}
        />
      );
    }
    if (typeof item.value === 'number') {
      return (
        <InputNumber
          min={0}
          max={10000}
          value={item.value}
          disabled={loading}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v) && v !== item.value) update(item.key, v);
          }}
          onPressEnter={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v) && v !== item.value) update(item.key, v);
          }}
        />
      );
    }
    return <span>{JSON.stringify(item.value)}</span>;
  };

  return (
    <>
      <Card size="small" title="AI 服务状态" style={{ marginBottom: 12 }}>
        {aiStatus ? (
          <Space wrap>
            <Tag color={aiStatus.provider === 'local' ? 'default' : 'blue'}>
              provider: {aiStatus.provider}
            </Tag>
            <Tag>model: {aiStatus.model || '-'}</Tag>
            <Tag color={aiStatus.apiKeyConfigured ? 'green' : 'red'}>
              {aiStatus.apiKeyConfigured ? 'API Key 已配置' : 'API Key 未配置（将使用本地规则）'}
            </Tag>
            <Button size="small" type="primary" loading={testing} onClick={runTest}>
              测试 AI 连通性
            </Button>
          </Space>
        ) : null}
        {testResult && (
          <pre style={{ background: '#fafafa', padding: 12, marginTop: 12, borderRadius: 4, fontSize: 12 }}>
            {JSON.stringify(testResult, null, 2)}
          </pre>
        )}
      </Card>
      <Table
        rowKey="key"
        dataSource={list}
        pagination={false}
        columns={[
          { title: '配置项', dataIndex: 'key', width: 200 },
          { title: '说明', dataIndex: 'description' },
          { title: '默认值', dataIndex: 'defaultValue', width: 100, render: (v) => JSON.stringify(v) },
          { title: '当前值', width: 120, render: (_, r) => renderControl(r) },
        ]}
      />
    </>
  );
}
