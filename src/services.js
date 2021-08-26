import fs from 'fs'
import path from 'path'
import vm from 'vm'
import mysql from 'mysql2/promise.js'
import sendSMS from './lib/sms/index.js'

const verify = (request) => {
  return new Promise((resolve, reject) => {
    request.jwtVerify(function (err, decoded) {
      if (err) return reject(err)
      resolve(decoded)
    })
  })
}

export default [{
  method: 'POST',
  path: '/api/auth',
  schema: {
    tags: ['common'],
    summary: '换取临时Token',
    description: '换取临时Token以使用需授权的API',
    body: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: '原始Token'
        }
      }
    }
  },
  config: {
    auth: false
  },
  async handler (request, reply) {
    const sign = (payload) => {
      return new Promise((resolve, reject) => {
        reply.jwtSign(payload, function (err, token) {
          if (err) reject(err)
          return resolve(token)
        })
      })
    }

    await this.$db.read()

    // Find
    const user = this.$db.data.users.find(i => i.token === request.body.token)

    if (user) {
      const username = user.username
      const generateJWT = (jwtInfo) => {
        const payload = {
          exp: Math.floor(new Date().getTime() / 1000) + 7 * 24 * 60 * 60
        }

        Object.assign(payload, jwtInfo)

        return sign(payload)
      }

      this.$db.data.logs.push({
        action: 'auth',
        success: true,
        result: {
          username,
          token: request.body.token
        },
        createdTime: new Date().getTime()
      })

      await this.$db.write()

      return this.success({
        token: await generateJWT({
          username
        })
      }, 1)
    } else {
      this.$db.data.logs.push({
        action: 'auth',
        success: false,
        result: {
          msg: 'Auth failed.',
          token: request.body.token
        },
        createdTime: new Date().getTime()
      })

      await this.$db.write()
    }

    return this.fail(null, 403, '认证失败。')
  }
},
{
  method: 'POST',
  path: '/api/manage/user/login',
  schema: {
    tags: ['system'],
    summary: '登录',
    description: '后台用户登录',
    body: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: '用户名'
        },
        password: {
          type: 'string',
          description: '密码'
        }
      }
    }
  },
  config: {
    auth: false
  },
  async handler (request, reply) {
    const sign = (payload) => {
      return new Promise((resolve, reject) => {
        reply.jwtSign(payload, function (err, token) {
          if (err) reject(err)
          return resolve(token)
        })
      })
    }

    const username = request.body.username

    // Find
    await this.$db.read()
    const user = this.$db.data.users.find(i => i.username === username)

    if (!user) return this.fail(null, 403, '认证失败。')

    if (this.$auth.createPassword(request.body.password) === user.password) {
      const generateJWT = (jwtInfo) => {
        const payload = {
          exp: Math.floor(new Date().getTime() / 1000) + 7 * 24 * 60 * 60
        }

        Object.assign(payload, jwtInfo)

        return sign(payload)
      }

      this.$db.data.logs.push({
        action: 'login',
        success: true,
        result: {
          username
        },
        createdTime: new Date().getTime()
      })

      await this.$db.write()

      return this.success({
        token: await generateJWT({
          username
        })
      }, 1)
    } else {
      this.$db.data.logs.push({
        action: 'login',
        success: false,
        result: {
          msg: 'Password auth failed.',
          username,
          password: request.body.password
        },
        createdTime: new Date().getTime()
      })

      await this.$db.write()
    }

    return this.fail(null, 403, '认证失败。')
  }
},
{
  method: 'GET',
  path: '/api/manage/user/info',
  schema: {
    tags: ['system'],
    summary: '获取后台数据',
    description: '获取后台数据，校检用户信息'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      return this.success({
        username
      }, 1)
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/manage/user/list',
  schema: {
    tags: ['system'],
    summary: '获取后台用户信息',
    description: '获取后台用户信息, 总管理员可以查看所有信息，其余管理员只能查看自己的数据。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user && user.isAdministrator === true) { // 超级管理员
        // Find
        const users = this.$deepClone(this.$db.data.users.sort((a, b) => b.createdTime - a.createdTime))

        for (const n in users) {
          users[n].password = ''
        }

        return this.success({
          userList: users,
          isAdministrator: true
        }, 1)
      } else if (user.username) {
        const userObj = this.$deepClone(user)
        userObj.password = ''
        return this.success({
          userList: [userObj],
          isAdministrator: false
        }, 1)
      }

      return this.fail(null, -1, '没有权限。')
    } catch (err) {
      this.log.error(err)
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/manage/user/edit',
  schema: {
    tags: ['system'],
    summary: '修改后台用户信息',
    description: '修改后台用户信息, 超级管理员可以修改所有信息，其余管理员只能修改自己的数据。密码为空则不修改密码。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (!user) return this.fail(null, 403, '认证失败。')

      if (user.isAdministrator !== true && request.body.username !== username) { // 非超级管理员且修改的不是自己的数据
        this.$db.data.logs.push({
          action: 'edit-user',
          success: false,
          result: {
            username: request.body.username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }

      if (!request.body.password || request.body.password === '') {
        const userTmp = this.$db.data.users.find(i => i.username === request.body.username)

        Object.assign(userTmp, {
          token: request.body.token
        })

        this.$db.data.logs.push({
          action: 'edit-user',
          success: true,
          result: {
            username: request.body.username,
            msg: 'token'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()
      } else {
        const userTmp = this.$db.data.users.find(i => i.username === request.body.username)

        Object.assign(userTmp, {
          password: this.$auth.createPassword(request.body.password),
          token: request.body.token
        })

        this.$db.data.logs.push({
          action: 'edit-user',
          success: true,
          result: {
            username: request.body.username,
            msg: 'Password and token'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()
      }

      return this.success(null, 1)
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/manage/user/add',
  schema: {
    tags: ['system'],
    summary: '添加新管理员',
    description: '添加新管理员, 仅超级管理员可以操作。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user.isAdministrator === true) { // 当前用户是超级管理员
        // Check
        const checkUser = this.$db.data.users.find(i => i.username === request.body.username)

        if (checkUser) {
          return this.fail(null, -1, '该用户名已存在。')
        }

        const user = {
          username: request.body.username,
          password: this.$auth.createPassword(request.body.password),
          token: this.$uuid(),
          isAdministrator: false,
          createdTime: new Date().getTime()
        }

        this.$db.data.users.push(user)

        this.$db.data.logs.push({
          action: 'register',
          success: true,
          result: {
            username: request.body.username
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(null, 1)
      } else {
        this.$db.data.logs.push({
          action: 'register',
          success: false,
          result: {
            username: request.body.username,
            password: request.body.password,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(err.toString(), 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/setting',
  schema: {
    tags: ['common'],
    summary: '获取设置信息',
    description: '获取设置信息（对象存储等）, 仅超级管理员可以查询。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user.isAdministrator) { // 超级管理员
        const config = this.$db.data.config

        this.$db.data.logs.push({
          action: 'get-setting',
          success: true,
          result: {
            username
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(JSON.stringify(config.setting), 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-setting',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/setting',
  schema: {
    tags: ['common'],
    summary: '写入设置信息',
    description: '写入设置信息, 仅超级管理员有权限。',
    body: {
      type: 'object',
      properties: {
        setting: {
          type: 'string',
          description: 'Setting的JSON字符串'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user.isAdministrator === true) { // 超级管理员
        const setting = request.body.setting
        const config = this.$db.data.config

        config.setting = JSON.parse(setting)

        this.$db.data.logs.push({
          action: 'set-setting',
          success: true,
          result: {
            username,
            setting
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(null, 1)
      } else {
        this.$db.data.logs.push({
          action: 'set-setting',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/template',
  schema: {
    tags: ['common'],
    summary: '获取新增数据库模板',
    description: '获取新增数据库模板, 仅管理员可以查询。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) {
        let template = fs.readFileSync(path.join(__dirname, 'template', 'mysql.js'), 'utf-8')

        template = template.replace(/uuid: '(.*)'/i, 'uuid: \'' + this.$uuid() + '\'')

        return this.success(template, 1)
      } else {
        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/database/test',
  schema: {
    tags: ['common'],
    summary: '测试数据库连接',
    description: '测试数据库连接, 仅管理员有权限。',
    body: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '新增数据库的Code字符串'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const code = request.body.code
        let res = null

        try {
          const context = {}
          const script = new vm.Script(code)

          script.runInNewContext(context)

          res = context.main()
        } catch (err) {
          return this.fail(err.toString(), -11, 'Code Error.')
        }

        // create the connection
        let error = null
        let connection = null
        try {
          connection = await mysql.createConnection(res.connection).catch(err => {
            error = err
            if (err) reply.send(this.fail(err.toString(), -13, '连接失败'))
          })
        } catch (err) {
          return this.fail(err.toString(), -12, '连接失败')
        }

        try {
          if (!error) {
            // query database
            const [rows] = await connection.execute('SHOW TABLES')

            return this.success(rows, 1, '连接成功')
          } else {
            return this.fail(error.toString(), -13, '连接失败')
          }
        } catch (err) {
          return this.fail(err.toString(), -14, '权限不足')
        }
      } else {
        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(err.toString(), 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/database/create',
  schema: {
    tags: ['common'],
    summary: '新增数据库信息',
    description: '新增数据库信息, 仅管理员有权限。请先调用测试接口确保测试通过再进行新增。',
    body: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '新增数据库的Code字符串'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const code = request.body.code

        try {
          const context = {}
          const script = new vm.Script(code)

          script.runInNewContext(context)

          const res = context.main()

          this.$db.data.databases.push(res)
          this.$db.data.codes.push({
            username,
            code,
            uuid: res.uuid,
            name: res.name,
            serviceProvider: res.serviceProvider,
            remarks: res.remarks,
            lastExecTime: null,
            createdTime: new Date().getTime(),
            updatedTime: new Date().getTime(),
            deletedTime: null
          })

          this.$db.data.logs.push({
            action: 'add-database',
            success: true,
            result: {
              username,
              code
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.success(null, 1)
        } catch (err) {
          return this.fail(err.toString(), -11, 'Code Error.')
        }
      } else {
        this.$db.data.logs.push({
          action: 'add-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(err.toString(), 403, '认证失败。')
    }
  }
},
{
  method: 'POST',
  path: '/api/database/edit',
  schema: {
    tags: ['common'],
    summary: '修改数据库信息',
    description: '修改数据库信息, 仅管理员有权限。请先调用测试接口确保测试通过再进行修改。',
    body: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: '修改数据库的UUID'
        },
        code: {
          type: 'string',
          description: '修改数据库的Code字符串'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const code = request.body.code

        try {
          const context = {}
          const script = new vm.Script(code)

          script.runInNewContext(context)

          const res = context.main()

          const uuid = request.body.uuid

          const database = this.$db.data.databases.find(i => i.uuid === uuid)

          Object.assign(database, res)

          const code = this.$db.data.codes.find(i => i.uuid === uuid)

          Object.assign(code, {
            username,
            code,
            uuid: res.uuid,
            name: res.name,
            serviceProvider: res.serviceProvider,
            remarks: res.remarks,
            updatedTime: new Date().getTime()
          })

          this.$db.data.logs.push({
            action: 'edit-database',
            success: true,
            result: {
              username,
              code,
              uuid
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.success(null, 1)
        } catch (err) {
          return this.fail(err.toString(), -11, 'Code Error.')
        }
      } else {
        this.$db.data.logs.push({
          action: 'edit-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(err.toString(), 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/objectStorage',
  schema: {
    tags: ['common'],
    summary: '获取当前启用的对象存储',
    description: '获取当前启用的对象存储列表, 仅管理员可以查询。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const config = this.$db.data.config
        const setting = config.setting

        const res = []

        if (setting.ObjectStorage.useQINIU) res.push('qiniu')
        if (setting.ObjectStorage.useCOS) res.push('cos')
        if (setting.ObjectStorage.useOSS) res.push('oss')

        this.$db.data.logs.push({
          action: 'view-setting',
          success: true,
          result: {
            username,
            res
          },
          createdTime: new Date().getTime()
        })

        return this.success(res, 1)
      } else {
        this.$db.data.logs.push({
          action: 'view-setting',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/list',
  schema: {
    tags: ['common'],
    summary: '获取数据库列表',
    description: '获取数据库列表, 仅管理员可以查询。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const codes = user.isAdministrator ? this.$db.data.codes.filter(i => i.deletedTime === null).sort((a, b) => b.createdTime - a.createdTime) : this.$db.data.codes.filter(i => i.deletedTime === null && i.username === username).sort((a, b) => b.createdTime - a.createdTime)

        return this.success(codes, 1)
      } else {
        this.$db.data.logs.push({
          action: 'view-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'DELETE',
  path: '/api/database/delete',
  schema: {
    tags: ['common'],
    summary: '删除数据库',
    description: '删除数据库, 仅超级管理员或所属管理员可操作。',
    body: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: {
          type: 'string',
          description: '数据库UUID'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        if (user.isAdministrator !== true) {
          const check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.body.uuid &&
              i.username === username
          })

          if (!check) {
            this.$db.data.logs.push({
              action: 'delete-database',
              success: false,
              result: {
                username,
                uuid: request.body.uuid,
                msg: '没有权限。'
              },
              createdTime: new Date().getTime()
            })

            return this.fail(null, -11, '没有权限。')
          }
        }

        const code = this.$db.data.codes.find(i => i.uuid === request.body.uuid)

        Object.assign(code, {
          deletedTime: new Date().getTime()
        })

        this.$db.data.logs.push({
          action: 'delete-database',
          success: true,
          result: {
            username,
            uuid: request.body.uuid
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(null, 1)
      } else {
        this.$db.data.logs.push({
          action: 'delete-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/getByUUID',
  schema: {
    tags: ['common'],
    summary: '通过UUID查询数据库',
    description: '通过UUID查询数据库, 仅超级管理员或所属管理员可操作。',
    querystring: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: {
          type: 'string',
          description: '数据库UUID'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        let check = null
        if (user.isAdministrator) {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid
          })
        } else {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid &&
              i.username === username
          })
        }

        if (!check) {
          this.$db.data.logs.push({
            action: 'get-database',
            success: false,
            result: {
              username,
              uuid: request.query.uuid,
              msg: '没有权限或没有找到对应的数据库。'
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.fail(null, -11, '没有权限或没有找到对应的数据库。')
        }

        const db = this.$db.data.databases.find(i => i.uuid === request.query.uuid)

        this.$db.data.logs.push({
          action: 'get-database',
          success: true,
          result: {
            username,
            uuid: request.query.uuid
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(db, 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/getByName',
  schema: {
    tags: ['common'],
    summary: '通过自定义名称查询数据库',
    description: '通过自定义名称查询数据库, 仅超级管理员或所属管理员可操作。',
    querystring: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: '数据库自定义名称'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        let check = null
        if (user.isAdministrator) {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.name === request.query.name
          })
        } else {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.name === request.query.name &&
              i.username === username
          })
        }

        if (!check) {
          this.$db.data.logs.push({
            action: 'get-database',
            success: false,
            result: {
              username,
              name: request.query.name,
              msg: '没有权限或没有找到对应的数据库。'
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.fail(null, -11, '没有权限或没有找到对应的数据库。')
        }

        const db = this.$db.data.databases.find(i => i.uuid === check.uuid)

        this.$db.data.logs.push({
          action: 'get-database',
          success: true,
          result: {
            username,
            name: request.query.name
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(db, 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-database',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/getExecLog',
  schema: {
    tags: ['common'],
    summary: '获取对应数据库的备份日志',
    description: '获取对应数据库的备份日志, 仅超级管理员或所属管理员可操作。',
    querystring: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: {
          type: 'string',
          description: '数据库UUID'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        let check = null
        if (user.isAdministrator) {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid
          })
        } else {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid &&
              i.username === username
          })
        }

        if (!check) {
          this.$db.data.logs.push({
            action: 'get-exec-log',
            success: false,
            result: {
              username,
              uuid: request.query.uuid,
              msg: '没有权限或没有找到对应的数据库。'
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.fail(null, -11, '没有权限或没有找到对应的数据库。')
        }

        const execLogs = this.$db.data.exec.filter(i => i.uuid === check.uuid).sort((a, b) => b.createdTime - a.createdTime)

        this.$db.data.logs.push({
          action: 'get-exec-log',
          success: true,
          result: {
            username,
            uuid: request.query.uuid
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(execLogs, 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-exec-log',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/getExecOtherLog',
  schema: {
    tags: ['common'],
    summary: '获取对备份记录的相关日志',
    description: '获取对备份记录的相关日志, 仅超级管理员或所属管理员可操作。',
    querystring: {
      type: 'object',
      required: ['uuid', 'execUUID'],
      properties: {
        uuid: {
          type: 'string',
          description: '数据库UUID'
        },
        execUUID: {
          type: 'string',
          description: 'execUUID'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const execUUID = request.query.execUUID
        let check = null
        if (user.isAdministrator) {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid
          })
        } else {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid &&
              i.username === username
          })
        }

        if (!check) {
          this.$db.data.logs.push({
            action: 'get-exec-other-log',
            success: false,
            result: {
              username,
              execUUID,
              uuid: request.query.uuid,
              msg: '没有权限或没有找到对应的数据库。'
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.fail(null, -11, '没有权限或没有找到对应的数据库。')
        }


        const execLogs = this.$db.data.exec.filter(i => i.execUUID === execUUID)

        for (let n = execLogs.length - 1; n >= 0; n--) {
          if (execLogs[n].result.uuid !== request.query.uuid) {
            execLogs.splice(n, 1)
          }
        }

        this.$db.data.logs.push({
          action: 'get-exec-other-log',
          success: true,
          result: {
            username,
            execUUID,
            uuid: request.query.uuid
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(execLogs, 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-exec-other-log',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/restore',
  schema: {
    tags: ['common'],
    summary: '解冻文件',
    description: '解冻文件, 仅超级管理员或所属管理员可操作。',
    querystring: {
      type: 'object',
      required: ['uuid', 'execUUID'],
      properties: {
        uuid: {
          type: 'string',
          description: '数据库UUID'
        },
        execUUID: {
          type: 'string',
          description: 'execUUID'
        }
      }
    }
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user) { // 管理员
        const execUUID = request.query.execUUID
        let check = null
        if (user.isAdministrator) {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid
          })
        } else {
          check = this.$db.data.codes.find(i => {
            return i.deletedTime === null &&
              i.uuid === request.query.uuid &&
              i.username === username
          })
        }

        if (!check) {
          this.$db.data.logs.push({
            action: 'get-exec-download',
            success: false,
            result: {
              username,
              execUUID,
              uuid: request.query.uuid,
              msg: '没有权限或没有找到对应的数据库。'
            },
            createdTime: new Date().getTime()
          })

          await this.$db.write()

          return this.fail(null, -11, '没有权限或没有找到对应的数据库。')
        }


        const exec = this.$db.data.exec.find(i => i.uuid === check.uuid && i.execUUID === execUUID)

        const res = await this.$restoreObject(exec.objectName, exec.objectStorageType)
        res.enableSMS = false

        const config = this.$db.data.config

        if (config.setting.SMS.enable && typeof config.setting.SMS.enable === "string") {
          const type = config.setting.SMS.enable

          if (type.length > 0 && config.setting.SMS[type].action.includes('downloadReady')) {
            const createdTime = this.$moment().format('MM月DD日HH:mm')
            const sendSMSHandler = () => {
              setTimeout(async () => {
                const restoreRes = await this.$restoreObject(exec.objectName, exec.objectStorageType)
                if (restoreRes.status === 3) {
                  sendSMS('downloadReady', {
                    createdTime,
                    name: exec.name,
                    successTime: this.$moment().format('MM月DD日HH:mm')
                  })
                } else if (restoreRes.status === 1 || restoreRes.status === 2) {
                  sendSMSHandler()
                }
              }, 10000)
            }

            sendSMSHandler()

            res.enableSMS = true
          }
        }

        this.$db.data.logs.push({
          action: 'get-exec-download',
          success: true,
          result: {
            username,
            execUUID,
            uuid: request.query.uuid,
            res: res
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        if (res.status === 3) {
          const key = this.$uuid()
          this.$db.data.download.push({
            key: key,
            objectName: exec.objectName,
            objectStorageType: exec.objectStorageType
          })

          await this.$db.write()

          res.key = key
        }

        return this.success(res, 1)
      } else {
        this.$db.data.logs.push({
          action: 'get-exec-download',
          success: false,
          result: {
            username,
            msg: '没有权限。'
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      console.log(err)
      return this.fail(null, 403, '认证失败。')
    }
  }
},
{
  method: 'GET',
  path: '/api/database/download',
  schema: {
    tags: ['common'],
    summary: '下载备份',
    description: '下载备份, 公开链接，使用key换取。需浏览器直接访问。',
    querystring: {
      type: 'object',
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          description: 'key'
        }
      }
    }
  },
  config: {
    auth: false
  },
  async handler (request, reply) {
    try {
      await this.$db.read()
      const key = request.query.key
      const exec = this.$db.data.download.find(i => i.key === key)
      const down = await this.$downloadObject(exec.objectName, exec.objectStorageType)
      const fileName = exec.objectName.split('/').pop()

      if (down.status !== 1) {
        return this.fail(null, -11, '下载文件请求发生错误。')
      }

      reply.headers({
        'Content-Type': down.contentType,
        'Content-Length': down.contentLength,
        'Content-Disposition': `attachment; filename="${fileName}"`
      })

      reply.send(down.outputStream)
      return
    } catch (err) {
      console.log(err)
      return this.fail(null, -12, '下载文件请求异常。')
    }
  }
},
{
  method: 'DELETE',
  path: '/api/log/delete',
  schema: {
    tags: ['common'],
    summary: '清理日志',
    description: '清理日志, 仅超级管理员可操作。'
  },
  config: {
    auth: true
  },
  async handler (request, reply) {
    try {
      const decoded = await verify(request)
      const username = decoded.username

      // Find
      await this.$db.read()
      const user = this.$db.data.users
        .find(i => i.username === username)

      if (user.isAdministrator) { // 管理员
        this.$db.data.logs = []
        this.$db.data.download = []

        this.$db.data.logs.push({
          action: 'delete-log',
          success: true,
          result: {
            username
          },
          createdTime: new Date().getTime()
        })

        await this.$db.write()

        return this.success(null, 1)
      } else {
        return this.fail(null, -10, '没有权限。')
      }
    } catch (err) {
      return this.fail(null, 403, '认证失败。')
    }
  }
}
]
