function main () {
  return { // 可以自由拓展更多字段，API将完整返回数据
    uuid: '', // 唯一标识，已随机生成。修改后将丢失备份记录
    name: '名称', // 自定义
    cron: '0 1 * * *', // 定时任务，可使用上方可视化设置，以代码为准
    serviceProvider: '', // 服务提供商，例如：腾讯云、阿里云等
    connection: {
      host: '', // 主机地址
      port: 3306,
      user: 'root',
      password: '',
      database: '', // 数据库名称
      charset: 'UTF8_GENERAL_CI',
      ssl: null
    },
    dumpOptions: {
      tables: [], // 需要备份的表名（空数组代表全部）
      excludeTables: false // 如果为false，则上一个选项为“不备份的表”，即黑名单
    },
    remoteHost: '', // 选填，仅记录
    remotePort: 3306, // 选填，仅记录
    mysqlVersion: '', // 选填，MySQL版本
    objectStorage: '', // 使用的对象存储（腾讯云 'cos'，阿里云 'oss'，七牛 'qiniu'），可以是数组。不能为空，否则将导致备份失败
    encryptZipFile: false, // 加密并压缩为ZIP文件，必填密码
    zipPassword: '', // 加密密码（encryptZipFile为true时必填）
    remarks: '备注'
  }
}