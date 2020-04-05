# MySQL Backup

[![license](https://img.shields.io/github/license/yi-ge/mysql-backup.svg?style=flat-square)](https://github.com/yi-ge/mysql-backup/blob/master/LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/yi-ge/mysql-backup.svg?style=flat-square)](https://github.com/yi-ge/mysql-backup)

[![JavaScript Style Guide](https://cdn.rawgit.com/standard/standard/master/badge.svg)](https://github.com/standard/standard)

Automatically get your mysql database backup and uploading it to the Object Storage.

自动获取 MySQL 数据库备份文件并将其上传到对象存储。

Demo: [https://mysql-backup.demo.wyr.me](https://mysql-backup.demo.wyr.me)

默认超级管理员  
账号：admin  
密码：admin888

![mysql-backup](https://cdn.wyr.me/imgs/mysql-buckup-preview.gif)

## Features

1. 支持加密后压缩上传（默认上传到私密存储的“归档存储”类型，文件需解冻后方可下载）。
2. 定时自动执行任务。
3. Web 可视化动态添加配置，支持同时管理多个数据库，可以设置需要备份的表或不需要备份的表。
4. ~~支持生成单个 PHP 文件，用于仅内网可访问数据库或虚拟主机数据库的备份。~~
5. ~~支持生成 Shell 文件，用于仅内网可访问数据库的备份。~~（由于 Docker 部署已非常方便，这个功能不再开发）
6. 支持 Swagger UI 查看 API，方便与其它系统整合。
7. 支持`超级管理员`添加多个`普通管理员`，`超级管理员`可以管理所有数据库，`普通管理员`之间内容互不可见，适合普通开发团队的使用场景。
8. 由于此系统仅为灾备设计，仅支持全量备份，默认备份`数据+结构`（包含视图、触发器等），不支持增量备份。如果您的数据非常重要，请勿将此作为唯一备份系统，可配合服务商提供的备份功能使用。
9. 兼容支持手机端访问。

## 使用方法

```bash
docker run -itd --name mysql-backup --restart always \
    -v /etc/localtime:/etc/localtime:ro \
    -v /data/db:/usr/src/app/db \
    -p 8080:80 \
    wy373226722/mysql-backup:latest
```

**注意事项：**

1. 为确保定时任务准确执行，请确保服务器宿主机的时区和时间设置正常。
2. 请修改`-v /data/db:/usr/src/app/db`为本地数据库存储路径，经 Docker 升级程序可不丢失数据。

**国内用户高速通道:**

阿里云：`docker pull registry.cn-shenzhen.aliyuncs.com/yi-ge/mysql-backup:latest`

腾讯云：`docker pull ccr.ccs.tencentyun.com/yi-ge/mysql-backup:latest`

**推荐用法:**
配合[docker-letsencrypt-nginx-proxy-companion](https://github.com/JrCs/docker-letsencrypt-nginx-proxy-companion)使用，快速生成 SSL 证书。

```bash
docker run --detach \
    --name nginx-proxy \
    --publish 80:80 \
    --publish 443:443 \
    --volume /etc/nginx/certs \
    --volume /etc/nginx/vhost.d \
    --volume /usr/share/nginx/html \
    --volume /var/run/docker.sock:/tmp/docker.sock:ro \
    jwilder/nginx-proxy

docker run --detach \
    --name nginx-proxy-letsencrypt \
    --volumes-from nginx-proxy \
    --volume /var/run/docker.sock:/var/run/docker.sock:ro \
    jrcs/letsencrypt-nginx-proxy-companion

docker run -itd --name mysql-backup --restart always \
    -v /etc/localtime:/etc/localtime:ro \
    -v /data/db:/usr/src/app/db \
    --env "VIRTUAL_PORT=80" \
    --env "VIRTUAL_HOST=你的域名" \
    --env "LETSENCRYPT_HOST=你的域名" \
    registry.cn-shenzhen.aliyuncs.com/yi-ge/mysql-backup:latest
```

### 系统环境变量

| 变量名       | 默认值      | 描述                         |
| ------------ | ----------- | ---------------------------- |
| `SCHEME`     | `"https"`   | `使用http还是https`          |
| `PORT`       | `"80"`      | `端口号`                     |
| `HOST`       | `"0.0.0.0"` | `监听的HOST`                 |
| `JWT_SECRET` | `随机数`    | `JWT私钥`                    |
| `WORKPATH`   | `db`        | `存储本地数据库（JSON文件）` |

**注意**  
通常情况下使用默认值即可，其余配置项可在系统后台进行配置。

## API 文档

**Swagger:** <https://yourdomain/documentation>

**在线文档:** <https://mysql-backup.demo.wyr.me/documentation>

## 支持的对象存储

- 阿里云
- 腾讯云
- 七牛云

### 对象存储使用须知

1. `阿里云对象存储`存储请在创建`Bucket`时选择“归档存储”，默认所有数据均创建为`归档存储`类型（最适合备份数据库、价格最低）。
2. 请创建`“私有”`类型的`Bucket`。
3. 数据需要先解冻才能访问，归档存储均无免费额度，操作归档存储 API 及取回数据均存在费用。
4. 归档存储的最小计量大小为 64 KB，小于 64KB 的 Object 按照 64KB 计算存储空间，超过 64KB 的 Object 按照实际大小计算存储空间。
5. 归档存储最短存储时间为 60 天（腾讯云为 90 天），早于 60 天删除的资源，其存储费用按 60 天计算。
6. `七牛云对象存储`解冻时间 1 ～ 5 分钟，解冻一次有效期 7 天。`阿里云对象存储`解冻时间 1 分钟，解冻一次有效期 24 小时。
7. `腾讯云对象存储`恢复模式：分别为标准模式、极速模式、批量模式，解冻一次有效期 7 天。

- 极速模式：需要的时间最短，只需要 1 ～ 15 分钟即可恢复。支持 256MB 以下文件的快速读取。当您在特定情况下，需要紧急获取档案数据的时候，使用加急模式可以大大缩短时间和提高效率。（备份系统默认小于 256MB 使用极速模式）
- 标准模式：使用标准模式，一般可以在 3 ～ 5 小时完成恢复。（备份系统大于 256MB 且小于 5GB 使用标准模式）
- 批量模式：成本最低，如果获取档案数据紧急程度低，采用批量模式可以用极低的成本获取大量的档案数据，一般在 5 ～ 12 小时可完成档案数据取回。（备份系统大于 5GB 使用批量模式）

### 对象存储参考文档

阿里云对象存储: [https://github.com/ali-sdk/ali-oss](https://github.com/ali-sdk/ali-oss)  
腾讯云对象存储: [https://github.com/tencentyun/cos-nodejs-sdk-v5](https://github.com/tencentyun/cos-nodejs-sdk-v5)  
七牛云对象存储: [https://developer.qiniu.com/kodo/sdk/1289/nodejs](https://developer.qiniu.com/kodo/sdk/1289/nodejs)

## 支持的短信通知

- 腾讯云
- SUBMAIL

短信功能需在设置中进行配置后才有效。

### 短信通知模板示例 1 （适用于腾讯云）

- 备份成功通知（默认不启用，3 为文件大小）
  名为"{1}"的数据库于{2}成功备份。{3}，{4}张表，导出{5}秒，上传到{6}耗时{7}秒，总计{8}秒。

- 备份失败通知
  名为"{1}"的数据库于{2}备份失败。请及时登录备份管理系统查看失败原因。

- 解冻成功通知
  您在{1}解冻下载名为"{2}"的数据库，其中一个备份文件于{3}解冻成功，请及时登录系统进行下载。

### 短信通知模板示例 2 （适用于 SUBMAIL）

- 备份成功通知（默认不启用）
  名为"@var(name)"的数据库于@var(createdTime)成功备份。@var(fileSize)，@var(tablesSum)张表，导出@var(dumpTime)秒，上传到@var(objectStorageType)耗时@var(uploadTime)秒，总计@var(jobTime)秒。

- 备份失败通知
  名为"@var(name)"的数据库于@var(createdTime)备份失败。请及时登录备份管理系统查看失败原因。

- 解冻成功通知
  您在@var(createdTime)解冻下载名为"@var(name)"的数据库，其中一个备份文件于@var(successTime)解冻成功，请及时登录系统进行下载。

## Q & A

1. 已经有云服务了，为什么还需要使用此系统？  
   A: 这取决于您的数据重要程度，这是一套灾备系统。

2. 是否支持其他数据库？  
   A: 这是一个早期的个人业余项目，由于我主要使用 MySQL 数据库，因此在[mysqldump](https://github.com/bradzacher/mysqldump)的基础上实现了 MySQL 的备份。开源的目的就是希望能有更多人的使用这个系统，受益的同时获得其它数据库备份功能的支持。

3. 为什么使用`jQuery + Bootstrap`这样的“过时”前端架构？为什么不用`Angular`、`Vue`、`React`来开发前端？  
   A: 这是由于历史原因决定的，我最初创建该系统的时候，采用`PHP混合HTML`实现，那时候还没有`Vue`之类的框架。并且`jQuery + Bootstrap`久经岁月考验，适合这类追求稳定的超小型系统。我已将相关依赖都升级为最新版并优化了部分代码。

4. 直接使用代码进行配置存在安全问题吗？  
   A: 这是一个自用系统，如果已有管理员权限必然也可以操作相应的功能，因此逻辑上不存在由此导致的安全问题。

5. 是否具备删除对象存储中备份数据的功能？  
   A: 不具备。在对象存储中的数据以“年/月/日”路径存储。为防止极端情况下导致数据被删除，故而不提供直接删除对象存储中备份数据的功能。

6. MySQL8 支持？  
   A: 支持 MySQL8，建议添加专属备份账号，使用 MySQL 自带身份认证。由于 mysqldump 模块限制，SHA2 认证方式尚未支持，此功能将随组件更新。

## 相关博文

[开源 MySQL 定时备份系统](https://www.wyr.me/post/614)
