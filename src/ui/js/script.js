require.config({
  paths: {
    vs: 'monaco-editor/min/vs'
  }
})

function formatDate (t) {
  var date = new Date(t)
  var YY = date.getFullYear() + '-'
  var MM = (date.getMonth() + 1 < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1) + '-'
  var DD = (date.getDate() < 10 ? '0' + (date.getDate()) : date.getDate())
  var hh = (date.getHours() < 10 ? '0' + date.getHours() : date.getHours()) + ':'
  var mm = (date.getMinutes() < 10 ? '0' + date.getMinutes() : date.getMinutes()) + ':'
  var ss = (date.getSeconds() < 10 ? '0' + date.getSeconds() : date.getSeconds())
  return YY + MM + DD + ' ' + hh + mm + ss
}

$(document).ready(function () {
  $('body').loading()
  window.isEdit = false

  // tip是提示信息，type:'success'是成功信息，'danger'是失败信息,'info'是普通信息,'warning'是警告信息
  var ShowTip = function (tip, type) {
    var $tip = $('#tip')
    if ($tip.length === 0) {
      $tip = $('<span id="tip" style="position:fixed;top:50px;left: 50%;z-index:9999;height: 35px;padding: 0 20px;line-height: 35px;"></span>')
      $('body').append($tip)
    }
    $tip.stop(true).prop('class', 'alert alert-' + type).text(tip).css('margin-left', -$tip.outerWidth() / 2).fadeIn(500).delay(2000).fadeOut(500)
  }

  var getUserList = function (callback) {
    $.get({
      url: '/api/manage/user/list',
      headers: {
        Authorization: 'Bearer ' + window.localStorage.token
      },
      success (data) {
        if (data.status === 1) {
          callback(data.result.userList, data.result.isAdministrator)
        } else {
          callback(null)
        }
      }
    })
  }

  window.logOperateEvents = {
    'click .download': function (e, value, row, index) {
      $.get({
        url: '/api/database/restore?uuid=' + row.uuid + '&execUUID=' + row.execUUID,
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        success (data) {
          if (data.status === 1) {
            if (data.result.status === 1) {
              $.toast({
                title: '开始解冻',
                subtitle: '预计耗时：' + data.result.waitingTime,
                content: '文件已开始解冻，请于解冻后再次访问并点击下载，解冻大约需要' + data.result.waitingTime + '。',
                type: 'info',
                delay: 30000
              })
            } else if (data.result.status === 2) {
              $.toast({
                title: '解冻中',
                subtitle: '预计耗时：' + data.result.waitingTime,
                content: '文件解冻中，请于解冻后再次访问并点击下载。从第一次点击下载开始计算，大约需要' + data.result.waitingTime + '。',
                type: 'warning',
                delay: 30000
              })
            } else if (data.result.status === 3) {
              ShowTip('解冻成功，开始下载。', 'success')
              window.open('/api/database/download?key=' + data.result.key)
            } else {
              ShowTip('发生未知错误，请检查系统日志。', 'danger')
            }
          } else {
            ShowTip(data.msg, 'warning')
          }
        }
      })
    },
    'click .exec-about-log': function (e, value, row, index) {
      $.get({
        url: '/api/database/getExecOtherLog?uuid=' + row.uuid + '&execUUID=' + row.execUUID,
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        success (data) {
          if (data.status === 1) {
            var logList = data.result
            if (logList.length > 0) {
              $('#exec-other-log-table').bootstrapTable('destroy')
              $('#exec-other-log-table').bootstrapTable({
                pagination: true,
                search: true,
                columns: [{
                  field: 'createdTime',
                  title: '日志时间',
                  sortable: true,
                  align: 'center',
                  formatter: function (value, row, index) {
                    return formatDate(value)
                  }
                }, {
                  field: 'success',
                  sortable: true,
                  align: 'center',
                  title: '是否成功'
                }, {
                  field: 'action',
                  sortable: true,
                  align: 'center',
                  title: '操作'
                }, {
                  field: 'result',
                  align: 'center',
                  title: '结果',
                  formatter: function (value, row, index) {
                    return JSON.stringify(value)
                  }
                }],
                data: logList
              })

              $('#execOtherLog').modal('show')
            } else {
              ShowTip('暂无数据', 'info')
            }
          } else {
            ShowTip(data.msg, 'warning')
          }
        }
      })
    }
  }

  window.operateEvents = {
    'click .edit-btn': function (e, value, row, index) {
      var uuid = row.uuid
      window.isEdit = true
      window.editUUID = uuid
      $('#database-title').text('更新数据库备份')

      $('#database').unbind('shown.bs.modal')
      $('#database').on('shown.bs.modal', function () {
        $.get({
          url: '/api/objectStorage',
          headers: {
            Authorization: 'Bearer ' + window.localStorage.token
          },
          success (data) {
            if (data.status === 1) {
              $('#object-storage-list').empty()

              $('#object-storage-list').text(JSON.stringify(data.result))
            } else {
              ShowTip(data.msg, 'warning')
            }
          }
        })

        var waitingEditorForEdit = function () {
          setTimeout(() => {
            if (window.editorReady === true) {
              $('#selector').empty()

              var cron = null
              try {
                cron = /cron: '(.*)'/.exec(row.code)
              } catch (err) {
                ShowTip('发生错误，请检查代码格式是否正确。报错信息：' + err.toString(), 'warning')
              }

              window.cron_field_time = 0
              window.cron_field = $('#selector').cron({
                initial: cron[1],
                onChange: function () {
                  if (window.cron_field_time !== 0) {
                    ShowTip('您修改了定时任务，请记得将其写入到代码。', 'info')
                  }
                  window.cron_field_time++
                  // console.log($(this).cron("value"))
                },
                useGentleSelect: true
              })

              window.$databaseEditor = $('#container-database')

              window.$databaseEditor.empty()

              window.databaseEditor = monaco.editor.create(window.$databaseEditor[0], {
                value: row.code,
                language: 'javascript'
              })

              window.databaseEditor.layout()
            } else {
              waitingEditorForEdit()
            }

            $('#database').loading('stop')
          }, 50)
        }

        waitingEditorForEdit()
      })

      $('#database').loading()
      $('#database').modal('show')
    },
    'click .log-btn': function (e, value, row, index) {
      $('#execLog').loading()

      var uuid = row.uuid

      $.get({
        url: '/api/database/getExecLog?uuid=' + uuid,
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        success (data) {
          if (data.status === 1) {
            var logList = data.result

            $('#exec-log-table').bootstrapTable('destroy')
            $('#exec-log-table').bootstrapTable({
              pagination: true,
              search: true,
              columns: [{
                field: 'startTime',
                title: '任务开始时间',
                sortable: true,
                align: 'center',
                formatter: function (value, row, index) {
                  return formatDate(value)
                }
              }, {
                field: 'success',
                sortable: true,
                align: 'center',
                title: '是否成功'
              }, {
                field: 'tables',
                sortable: true,
                align: 'center',
                title: '表数量'
              }, {
                field: 'objectStorageType',
                sortable: true,
                align: 'center',
                title: '对象存储类型',
                formatter: function (value, row, index) {
                  switch (value) {
                    case 'qiniu':
                      return '七牛云'
                    case 'oss':
                      return '阿里云'
                    case 'cos':
                      return '腾讯云'
                  }
                }
              }, {
                field: 'dumpTime',
                title: '导出备份耗时',
                sortable: true,
                align: 'center',
                formatter: function (value, row, index) {
                  return (row.dumpTime - row.startTime) / 1000
                }
              }, {
                field: 'uploadTime',
                title: '上传备份耗时',
                sortable: true,
                align: 'center',
                formatter: function (value, row, index) {
                  return (row.uploadTime - row.dumpTime) / 1000
                }
              }, {
                field: 'createdTime',
                title: '任务执行耗时',
                sortable: true,
                align: 'center',
                formatter: function (value, row, index) {
                  return (row.createdTime - row.startTime) / 1000
                }
              }, {
                title: '操作',
                align: 'center',
                clickToSelect: false,
                events: window.logOperateEvents,
                formatter: function (value, row, index) {
                  return `<div class="button button-small download">
                  解冻下载
                </div>
                <div class="button button-small exec-about-log" style="margin-left: 5px">
                  相关日志
                </div>`
                }
              }],
              data: logList
            })

            $('#execLog').modal('show')
          } else {
            ShowTip(data.msg, 'warning')
          }

          $('#execLog').loading('stop')
        }
      })
    },
    'click .del-btn': function (e, value, row, index) {
      var uuid = row.uuid
      if (confirm('删除后将停止备份，您确定吗？')) {
        $.ajax({
          type: 'delete',
          url: '/api/database/delete',
          headers: {
            Authorization: 'Bearer ' + window.localStorage.token
          },
          dataType: 'json',
          contentType: 'application/json',
          data: JSON.stringify({
            uuid
          }),
          success (data) {
            if (data.status === 1) {
              ShowTip('删除成功', 'success')
              init()
            } else {
              ShowTip(data.msg, 'danger')
            }
          }
        })
      }
    }
  }

  var init = function () {
    window.editorReady = false
    require(['vs/editor/editor.main'], function () {
      window.editorReady = true
    })
    $('#username-view').text('当前用户：' + window.username)

    getUserList(function (userList, isAdministrator) {
      if (isAdministrator) {
        $('#user-modal-label').text('账户管理（当前用户是超级管理员）')
      } else {
        $('#add-user').hide()
      }

      var content = ''
      for (var n in userList) {
        content += `<tr data-id="${userList[n].username}">
          <th scope="row">${(parseInt(n) + 1)}</th>
          <td data-field="username">${userList[n].username}</td>
          <td data-field="password">***</td>
          <td data-field="token">${userList[n].token}</td>
          <td>
            <a class="button button-small edit" title="Edit">
              <i class="fa fa-pencil"></i>
            </a>
          </td>
        </tr>`
      }

      $('#user-table tbody').empty()
      $('#user-table tbody').append(content)

      var pickers = {}

      $('#user-table tr').editable({
        disabled: ['username'],
        password: {
          password: '***'
        },
        edit: function (values) {
          $('.edit i', this)
            .removeClass('fa-pencil')
            .addClass('fa-save')
            .attr('title', 'Save')
        },
        save: function (values) {
          $.post({
            url: '/api/manage/user/edit',
            headers: {
              Authorization: 'Bearer ' + window.localStorage.token
            },
            dataType: 'json',
            contentType: 'application/json',
            data: JSON.stringify(values),
            success (data) {
              if (data.status === 1) {
                ShowTip('修改成功', 'success')
                init()
              } else {
                ShowTip(data.msg, 'danger')
              }
            }
          })

          $('.edit i', this)
            .removeClass('fa-save')
            .addClass('fa-pencil')
            .attr('title', 'Edit')

          if (this in pickers) {
            pickers[this].destroy()
            delete pickers[this]
          }
        },
        cancel: function (values) {
          $('.edit i', this)
            .removeClass('fa-save')
            .addClass('fa-pencil')
            .attr('title', 'Edit')

          if (this in pickers) {
            pickers[this].destroy()
            delete pickers[this]
          }
        }
      })

      $('#save-user').click(function () {
        $.post({
          url: '/api/manage/user/add',
          headers: {
            Authorization: 'Bearer ' + window.localStorage.token
          },
          dataType: 'json',
          contentType: 'application/json',
          data: JSON.stringify({
            username: $('#inputUsername').val(),
            password: $('#inputPassword').val()
          }),
          success (data) {
            if (data.status === 1) {
              ShowTip('添加成功', 'success')
              $('#inputUsername').val('')
              $('#inputPassword').val('')
              $('#userAdd').modal('hide')
              init()
            } else {
              ShowTip(data.msg, 'danger')
            }
          }
        })
      })

      $('.loading').hide()
    })

    $('#del-log').click(function () {
      $.ajax({
        type: 'delete',
        url: '/api/log/delete',
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        dataType: 'json',
        contentType: 'application/json',
        success (data) {
          if (data.status === 1) {
            ShowTip('清理成功', 'success')
          } else {
            ShowTip(data.msg, 'danger')
          }
        }
      })
    })

    $('#setting').on('shown.bs.modal', function () {
      var waitingEditor = function () {
        setTimeout(() => {
          if (window.editorReady === true) {
            $.get({
              url: '/api/setting',
              headers: {
                Authorization: 'Bearer ' + window.localStorage.token
              },
              success (data) {
                if (data.status === 1) {
                  window.$settingEditor = $('#container-setting')

                  window.$settingEditor.empty()

                  window.settingEditor = monaco.editor.create(window.$settingEditor[0], {
                    value: JSON.stringify(JSON.parse(data.result), null, 2),
                    language: 'json'
                  })

                  window.settingEditor.layout()
                } else {
                  ShowTip(data.msg, 'warning')
                }

                $('#setting').loading('stop')
              }
            })
          } else {
            waitingEditor()
          }
        }, 50)
      }

      waitingEditor()
    })

    $('#setting-btn').click(function () {
      $('#setting').loading()
      $('#setting').modal('show')
    })

    $('#save-setting').click(function () {
      $.post({
        url: '/api/setting',
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        dataType: 'json',
        contentType: 'application/json',
        data: JSON.stringify({
          setting: window.settingEditor.getValue()
        }),
        success (data) {
          if (data.status === 1) {
            $('#setting').modal('hide')
            init()
            ShowTip('设置保存成功', 'success')
          } else {
            ShowTip(data.msg, 'danger')
          }
        }
      })
    })

    $('#add-databases').click(function () {
      $('#database').loading()
      $('#database-title').text('创建数据库备份')
      window.isEdit = false

      $('#database').unbind('shown.bs.modal')
      $('#database').on('shown.bs.modal', function () {
        $.get({
          url: '/api/objectStorage',
          headers: {
            Authorization: 'Bearer ' + window.localStorage.token
          },
          success (data) {
            if (data.status === 1) {
              $('#object-storage-list').empty()

              $('#object-storage-list').text(JSON.stringify(data.result))
            } else {
              ShowTip(data.msg, 'warning')
            }
          }
        })

        var waitingEditor = function () {
          setTimeout(() => {
            if (window.editorReady === true) {
              $.get({
                url: '/api/database/template',
                headers: {
                  Authorization: 'Bearer ' + window.localStorage.token
                },
                success (data) {
                  if (data.status === 1) {
                    $('#selector').empty()

                    window.cron_field_time = 0
                    window.cron_field = $('#selector').cron({
                      initial: '0 1 * * *',
                      onChange: function () {
                        if (window.cron_field_time !== 0) {
                          ShowTip('您修改了定时任务，请记得将其写入到代码。', 'info')
                        }
                        window.cron_field_time++
                        // console.log($(this).cron("value"))
                      },
                      useGentleSelect: true
                    })

                    window.$databaseEditor = $('#container-database')

                    window.$databaseEditor.empty()

                    window.databaseEditor = monaco.editor.create(window.$databaseEditor[0], {
                      value: data.result,
                      language: 'javascript'
                    })

                    window.databaseEditor.layout()
                  } else {
                    ShowTip(data.msg, 'warning')
                  }

                  $('#database').loading('stop')
                }
              })
            } else {
              waitingEditor()
            }
          }, 50)
        }

        waitingEditor()
      })
      $('#database').modal('show')
    })

    $('#test-database').click(function () {
      $.post({
        url: '/api/database/test',
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        dataType: 'json',
        contentType: 'application/json',
        data: JSON.stringify({
          code: window.databaseEditor.getValue()
        }),
        success (data) {
          if (data.status === 1) {
            $.toast({
              title: '测试结果',
              subtitle: data.msg,
              content: data.result.length > 0 ? '共' + data.result.length + '张数据表' : '数据库中没有表',
              type: 'success',
              delay: 5000
            })
          } else {
            $.toast({
              title: '测试结果',
              subtitle: data.msg,
              content: data.result,
              type: 'info',
              delay: 5000
            })
          }
        }
      })
    })

    $('#save-database').click(function () {
      var currentValue = window.cron_field.cron('value')
      var code = window.databaseEditor.getValue()

      try {
        var cron = /cron: '(.*)'/.exec(code)
        if (cron[1] !== currentValue) {
          if (!confirm('定时任务可视化设置与代码不一致，您确定继续吗？')) {
            return
          }
        }
      } catch (err) {
        ShowTip('发生错误，请检查代码格式是否正确。报错信息：' + err.toString(), 'warning')
        return
      }

      $.post({
        url: '/api/database/test',
        headers: {
          Authorization: 'Bearer ' + window.localStorage.token
        },
        dataType: 'json',
        contentType: 'application/json',
        data: JSON.stringify({
          code: window.databaseEditor.getValue()
        }),
        success (data) {
          if (data.status === 1) {
            var bodyData = {
              code: window.databaseEditor.getValue()
            }

            if (window.isEdit) {
              bodyData.uuid = window.editUUID
            }

            $.post({
              url: '/api/database/' + (window.isEdit ? 'edit' : 'create'),
              headers: {
                Authorization: 'Bearer ' + window.localStorage.token
              },
              dataType: 'json',
              contentType: 'application/json',
              data: JSON.stringify(bodyData),
              success (data) {
                if (data.status === 1) {
                  $('#database').modal('hide')
                  ShowTip((window.isEdit ? '修改' : '创建') + '成功', 'success')
                  init()
                } else {
                  ShowTip(data.msg, 'danger')
                }
              }
            })
          } else {
            $.toast({
              title: '测试结果',
              subtitle: data.msg,
              content: data.result,
              type: 'info',
              delay: 5000
            })

            ShowTip('保存失败：测试不通过，请您先修改代码。', 'danger')
          }
        }
      })
    })

    $('#cron-read').click(function () {
      var code = window.databaseEditor.getValue()

      try {
        var cron = /cron: '(.*)'/.exec(code)
        window.cron_field.cron('value', cron[1])
        ShowTip('成功读取', 'success')
      } catch (err) {
        ShowTip('发生错误，请检查代码格式是否正确。报错信息：' + err.toString(), 'warning')
      }
    })

    $('#cron-write').click(function () {
      var currentValue = window.cron_field.cron('value')
      var code = window.databaseEditor.getValue()

      try {
        window.databaseEditor.setValue(code.replace(/cron: '(.*)'/i, 'cron: \'' + currentValue + '\''))
        ShowTip('成功写入', 'success')
      } catch (err) {
        ShowTip('发生错误，请检查代码格式是否正确。报错信息：' + err.toString(), 'warning')
      }
    })

    $('.no-sheet').text('加载中...').show()

    $.get({
      url: '/api/database/list',
      headers: {
        Authorization: 'Bearer ' + window.localStorage.token
      },
      success (data) {
        if (data.status === 1) {
          var databaseList = data.result
          if (databaseList.length > 0) {
            $('#databases-table').bootstrapTable('destroy')
            $('#databases-table').bootstrapTable({
              pagination: true,
              search: true,
              columns: [{
                title: '#',
                field: 'uuid',
                sortable: true,
                align: 'center',
                valign: 'middle',
                formatter: function (value, row, index) {
                  return index + 1
                }
              }, {
                field: 'name',
                sortable: true,
                align: 'center',
                valign: 'middle',
                title: '名称'
              }, {
                field: 'serviceProvider',
                sortable: true,
                align: 'center',
                valign: 'middle',
                title: '服务商'
              }, {
                field: 'remarks',
                halign: 'center',
                align: 'left',
                valign: 'middle',
                class: 'remark',
                title: '备注'
              }, {
                field: 'lastExecTime',
                title: '备份时间',
                valign: 'middle',
                width: 180,
                sortable: true,
                align: 'center',
                formatter: function (value, row, index) {
                  return value ? formatDate(value) : '暂无'
                }
              }, {
                title: '操作',
                align: 'center',
                valign: 'middle',
                clickToSelect: false,
                width: 180,
                events: window.operateEvents,
                formatter: function (value, row, index) {
                  return `<div class="button button-small edit-btn" style="margin-right: 5px">
                  更新
                </div>
                <div class="button button-small log-btn" style="margin-right: 5px">
                  任务
                </div>
                <div class="button button-small del-btn">
                  删除
                </div>`
                }
              }],
              data: databaseList
            })

            $('.no-sheet').hide()
          } else {
            $('#databases-table').empty()
            $('.no-sheet').text('暂无数据').show()
          }

          $('body').loading('stop')
        } else {
          ShowTip(data.msg, 'warning')
        }
      }
    })
  }

  $.get({
    url: '/api/manage/user/info',
    headers: {
      Authorization: 'Bearer ' + window.localStorage.token
    },
    success (data) {
      if (data.status === 1 && data.result.username) {
        window.username = data.result.username
        init()
      } else {
        window.location.href = 'admin.html'
      }
    },
    error () {
      window.localStorage.token = null
      window.location.href = 'admin.html'
    }
  })

  $('#load-api').click(() => {
    window.open('/documentation')
  })

  $('#logout').click(() => {
    window.username = null
    window.localStorage.token = null
    window.location.href = 'admin.html'
  })
})
