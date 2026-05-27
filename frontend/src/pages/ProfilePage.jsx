import { useEffect, useState } from 'react';
import { Card, Avatar, Descriptions, Space, Tag, Form, Input, Button, App, Switch, Statistic, Row, Col } from 'antd';
import { useParams, useSearchParams } from 'react-router-dom';
import { userApi } from '../api';
import { useAuthStore } from '../store/auth.js';

export default function ProfilePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = params.get('edit') === '1';
  const [profile, setProfile] = useState(null);
  const { user, setUser } = useAuthStore();
  const { message } = App.useApp();
  const [form] = Form.useForm();

  useEffect(() => {
    userApi.getProfile(id).then((p) => {
      setProfile(p);
      form.setFieldsValue({
        nickname: p.nickname,
        bio: p.bio,
        techTags: p.techTags,
        emailNotify: user?.emailNotify,
      });
    });
  }, [id]);

  if (!profile) return <Card loading />;

  const isMe = user?.id === profile.id;

  const onSave = async (values) => {
    const updated = await userApi.updateMe(values);
    setUser({ ...user, ...updated });
    message.success('已保存');
  };

  return (
    <Card>
      <Space size="large" align="start">
        <Avatar size={80} src={profile.avatar}>{profile.name?.[0]}</Avatar>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>
            {profile.nickname || profile.name}{' '}
            <Tag color="blue">{profile.department}</Tag>
            <Tag>{profile.role}</Tag>
          </h2>
          <p style={{ color: '#8c8c8c' }}>{profile.bio || '暂无介绍'}</p>
          <Space wrap>
            {(profile.techTags || '').split(',').filter(Boolean).map((t) => <Tag key={t} color="geekblue">{t}</Tag>)}
          </Space>
        </div>
      </Space>

      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col span={6}><Statistic title="发帖数" value={profile.stats?.postCount || 0} /></Col>
        <Col span={6}><Statistic title="获赞数" value={profile.stats?.likeReceived || 0} /></Col>
        <Col span={6}><Statistic title="收藏数" value={profile.stats?.favoriteCount || 0} /></Col>
        <Col span={6}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="工号">{profile.empNo}</Descriptions.Item>
          </Descriptions>
        </Col>
      </Row>

      {isMe && editing && (
        <Card type="inner" title="编辑资料" style={{ marginTop: 24 }}>
          <Form form={form} layout="vertical" onFinish={onSave}>
            <Form.Item label="昵称" name="nickname">
              <Input />
            </Form.Item>
            <Form.Item label="个人简介" name="bio">
              <Input.TextArea rows={3} maxLength={500} showCount />
            </Form.Item>
            <Form.Item label="技术标签 (逗号分隔)" name="techTags">
              <Input placeholder="React, Vue, Node.js" />
            </Form.Item>
            <Form.Item label="邮件通知" name="emailNotify" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Button type="primary" htmlType="submit">保存</Button>
          </Form>
        </Card>
      )}
    </Card>
  );
}
