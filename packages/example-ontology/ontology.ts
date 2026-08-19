/**
 * ═══════════════════════════════════════════════════════════════════
 *  PROTOTYPE — 反应物本体（票 #12）。迷你 HR/项目管理领域：
 *  读这份文件的手感，就是这张票要回答的问题。
 *  覆盖：struct 复用 / 九类标量 / 数组 / 就地约束 / 三档基数链接 /
 *       载荷升级中间对象 / 动作（动态默认·校验·乐观锁）/ 函数注册
 * ═══════════════════════════════════════════════════════════════════
 */

import { structType, objectType, link, action, queryFn, prop as p, ValidationFailed } from '@heirloom/dsl';

// ═══ struct：无身份的嵌入形状，跨类型复用（ADR-0001 决策 1）═══

export const Address = structType({
  apiName: 'address',
  displayName: '地址',
  properties: {
    street: p.string().required(),
    city: p.string().required(),
    zip: p.string().length(5, 10),
  },
});

export const Money = structType({
  apiName: 'money',
  displayName: '金额',
  properties: {
    amount: p.decimal().required(), // decimal = JSON 字符串编码
    currency: p.enum(['CNY', 'USD', 'EUR']).default('CNY'),
  },
});

// ═══ 对象类型 ═══

export const Department = objectType({
  apiName: 'department',
  displayName: '部门',
  properties: {
    name: p.string().required().unique().length(1, 80).displayName('部门名'),
    budget: p.decimal().range(0).description('年度预算（元）'),
  },
  links: {
    // 1:N。单侧声明，反向名显式给出；员工侧获得 department 反向遍历
    employees: link.oneToMany(() => Employee, { reverse: 'department', displayName: '成员' }),
  },
});

export const Employee = objectType({
  apiName: 'employee',
  displayName: '员工',
  description: '组织成员。服务端 UUID 主键，语言层不声明。',
  properties: {
    employeeNo: p.string().required().unique().displayName('工号'), // 业务键 = unique 约束
    name: p.string().required().length(1, 80),
    email: p.string().regex(/^[^@\s]+@[^@\s]+$/),
    status: p.enum(['active', 'on-leave', 'offboarded']).default('active'),
    salary: p.decimal().range(0),
    hiredAt: p.date(),
    certifications: p.string().array().unique(), // 数组 + unique = 集合语义
    address: p.struct(Address),                    // 嵌入 struct
    metadata: p.json(),                            // 逃生舱
  },
  links: {
    // 1:1 自链接。thunk 标注 any 是 TS 循环初始化的硬限制（drizzle 的
    // `(): AnyPgColumn => table.id` 同款）——DSL 定稿时要决定这个毛边怎么收
    mentor: link.oneToOne((): any => Employee, { reverse: 'mentee', displayName: '导师' }),
    // M:N；反向名省略 → 派生为 'employee'（声明方 apiName 原样，#12 决议）
    skills: link.manyToMany(() => Skill, { displayName: '技能' }),
  },
});

export const Skill = objectType({
  apiName: 'skill',
  displayName: '技能',
  properties: {
    name: p.string().required().unique(),
  },
  links: {},
});

export const Project = objectType({
  apiName: 'project',
  displayName: '项目',
  properties: {
    code: p.string().required().unique(),
    title: p.string().required(),
    startsOn: p.date(),
    budget: p.struct(Money),
  },
  links: {},
});

// 链接载荷升级模式（ADR-0001 决策 6）：Membership 的 role/joinedAt 是
  //「员工—项目」关系的载荷，建模为中间对象类型 + 两条 1:N
export const Membership = objectType({
  apiName: 'membership',
  displayName: '项目成员关系',
  properties: {
    role: p.enum(['lead', 'contributor', 'reviewer']).required(),
    joinedAt: p.date().required(),
  },
  links: {
    employee: link.manyToOne(() => Employee, { reverse: 'memberships', required: true }),
    project: link.manyToOne(() => Project, { reverse: 'memberships', required: true }),
  },
});

// ═══ 动作：v1 语义层唯一写路径（ADR-0003）═══

export const createDepartment = action({
  apiName: 'create-department',
  displayName: '新建部门',
  params: {
    name: p.string().required(),
    budget: p.decimal().range(0),
  },
  execute: (ctx, { name, budget }) => {
    const dept = ctx.create(Department, { name, budget });
    return { departmentId: dept.id };
  },
});

export const hireEmployee = action({
  apiName: 'hire-employee',
  displayName: '录用员工',
  params: {
    employeeNo: p.string().required(),
    name: p.string().required(),
    department: p.ref(() => Department).required(), // 传 UUID，execute 前注入完整对象
    salary: p.decimal().range(0),
    hiredAt: p.date().default((ctx) => ctx.today), // 动态默认（ADR-0003 决策 2）
    mentor: p.ref(() => Employee),                   // 可选对象引用
    certifications: p.string().array().unique(),
    address: p.struct(Address),                      // struct 复用为参数形状
  },
  execute: (ctx, { employeeNo, name, department, salary, hiredAt, mentor, certifications, address }) => {
    // 动态校验全在 execute 内（ADR-0003 决策 3）：注入的部门对象可直接读
    if (salary && department.budget && Number(salary) > Number(department.budget)) {
      throw new ValidationFailed({ salary: `年薪 ¥${salary} 超过部门「${department.name}」预算 ¥${department.budget}` });
    }
    const employee = ctx.create(Employee, { employeeNo, name, salary, hiredAt, certifications, address });
    ctx.link(Department, department, 'employees', employee);
    if (mentor) ctx.link(Employee, employee, 'mentor', mentor);
    return { employeeId: employee.id };
  },
});

export const grantSkill = action({
  apiName: 'grant-skill',
  displayName: '授予技能',
  params: {
    employee: p.ref(() => Employee).required(),
    skillName: p.string().required(),
  },
  execute: (ctx, { employee, skillName }) => {
    // 无 upsert（ADR-0003 决策 4）：显式「查-建」两步，RYW 保证本事务可查到自己刚建的
    const skill = ctx.all(Skill).find((s) => s.name === skillName) ?? ctx.create(Skill, { name: skillName });
    ctx.link(Employee, employee, 'skills', skill);
    return { skillId: skill.id };
  },
});

export const createProject = action({
  apiName: 'create-project',
  displayName: '新建项目',
  params: {
    code: p.string().required(),
    title: p.string().required(),
    startsOn: p.date(),
    budget: p.struct(Money),
  },
  execute: (ctx, params) => {
    const project = ctx.create(Project, params);
    return { projectId: project.id };
  },
});

export const assignToProject = action({
  apiName: 'assign-to-project',
  displayName: '分配项目',
  params: {
    employee: p.ref(() => Employee).required(),
    project: p.ref(() => Project).required(),
    role: p.enum(['lead', 'contributor', 'reviewer']).default('contributor'),
    joinedAt: p.date().default((ctx) => ctx.today),
  },
  execute: (ctx, { employee, project, role, joinedAt }) => {
    const membership = ctx.create(Membership, { role, joinedAt });
    // 同事务新建对象可直接引用（ADR-0003 决策 5）；两条 required 链接在提交时校验
    ctx.link(Membership, membership, 'employee', employee);
    ctx.link(Membership, membership, 'project', project);
    return { membershipId: membership.id };
  },
});

export const transferEmployee = action({
  apiName: 'transfer-employee',
  displayName: '调动部门',
  params: {
    employee: p.ref(() => Employee).required(),
    toDepartment: p.ref(() => Department).required(),
  },
  execute: (ctx, { employee, toDepartment }) => {
    // 1:N 重挂：link 即移动，旧部门链接自动摘除
    ctx.link(Department, toDepartment, 'employees', employee);
    return { employeeId: employee.id, departmentId: toDepartment.id };
  },
});

export const adjustSalary = action({
  apiName: 'adjust-salary',
  displayName: '调薪',
  params: {
    employee: p.ref(() => Employee).required(),
    newSalary: p.decimal().required().range(0),
    expectedUpdatedAt: p.datetime(), // 乐观锁（ADR-0003 决策 8）：传了才校验
  },
  execute: (ctx, { employee, newSalary, expectedUpdatedAt }) => {
    ctx.modify(Employee, employee, { salary: newSalary }, { expectedUpdatedAt });
    return { employeeId: employee.id };
  },
});

export const offboardEmployee = action({
  apiName: 'offboard-employee',
  displayName: '离职',
  params: {
    employee: p.ref(() => Employee).required(),
  },
  execute: (ctx, { employee }) => {
    // 删除语义（ADR-0002）：required 链接阻止删除，optional 自动摘链
    ctx.delete(employee);
    return { employeeId: employee.id };
  },
});

// ═══ 函数注册：v1 只读查询接口位（ADR-0003 决策 7；调用桥 → v2）═══

export const departmentRoster = queryFn({
  apiName: 'department-roster',
  displayName: '部门花名册',
  params: {
    department: p.ref(() => Department).required(),
  },
  execute: (q, { department }) => {
    // q 是只读上下文：无 create/modify/delete/link/unlink
    return q.linked(Department, department, 'employees').map((e) => ({
      id: e.id,
      employeeNo: e.employeeNo,
      name: e.name,
      status: e.status,
    }));
  },
});

export const projectTeam = queryFn({
  apiName: 'project-team',
  displayName: '项目组',
  params: {
    project: p.ref(() => Project).required(),
  },
  execute: (q, { project }) => {
    // 反向遍历（按反向名）：载荷经中间对象读出
    return q.backlinks(Project, project, 'memberships').map((m) => ({
      role: m.role,
      joinedAt: m.joinedAt,
      employee: q.linked(Membership, m, 'employee')[0]?.name,
    }));
  },
});
