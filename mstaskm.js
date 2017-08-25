#!/usr/bin/env node
'use strict'

const PORT = 8079

const url = require('url')
const http = require('http')
const express = require('express')
const fsp = require('fs-promise')
const bodyParser = require('body-parser')
const spawn = require('child_process').spawn
const WebSocketServer = require('ws').Server
const EventEmitter = require('events')

const app = express()
const server = http.createServer()
const wss = new WebSocketServer({server: server})

let tasks = null

const eventEmitter = new EventEmitter()
const logs = {}

function nop() {
  // Do nothing
}

function loadTasks() {
  return fsp.readFile('tasks.json', 'utf8')
    .then(contents => {
      const obj = JSON.parse(contents)
      tasks = obj

      for (let id in tasks) {
        logs[id] = []
      }
    })
}

function initWSS() {
  wss.on('connection', (ws) => {
    const path = url.parse(ws.upgradeReq.url, true).path
    const id = path.slice(1)
    console.log('Log connection', id)
    logs[id].push(ws)
    ws.send('!\n\n====\nConnected!\n----\n')

    ws.on('close', () => {
      logs[id].pop(logs[id].indexOf(ws))
    })
  })
}

function initExpress() {
  app.use(require('express-promise')())

  app.use(express.static(__dirname + '/public'))
  app.use('/bower_components', express.static(__dirname + '/bower_components'))

  app.use('/api/*', bodyParser.json())
  app.all('/api/*', (req, res, next) => {
    console.log(`API request: ${req.method} ${req.url}`, req.body)
    next()
  })

  app.get('/api/tasks', (req, res) => {
    res.write(JSON.stringify(tasks, null, 2))
    res.end()
  })

  app.post('/api/cancel-all', (req, res) => {
    eventEmitter.emit('cancelAll')
    res.end()
  })

  app.post('/api/run-task', (req, res) => {
    const id = req.body.id

    if (!(Object.getOwnPropertyNames(tasks).includes(id))) {
      res.end(JSON.stringify({
        error: 'bad'
      }))
      return
    }

    const command = tasks[id].command
    console.log('Command:', command)

    setTimeout(() => {
      let args = []

      if (Array.isArray(command[1])) {
        args = command[1]
      } else {
        args = command.slice(1)
      }

      const cmd = spawn(command[0], args, {detached: true})

      const handleData = x => data => {
        let line = data.toString()

        // Remove colors.. D:
        line = line.replace(/\[[0-9;]*m/g, '')

        process.stdout.write(`[${id}] ${line}`)

        const sent = x + line

        for (let ws of logs[id]) {
          ws.send(sent, nop)
        }
      }

      let handleCancelAll = () => {
        // Thanks, http://azimi.me/2014/12/31/kill-child_process-node-js.html!
        process.kill(-cmd.pid)
      }

      eventEmitter.on('cancelAll', handleCancelAll)

      cmd.stdout.on('data', handleData('O'))
      cmd.stderr.on('data', handleData('E'))
      cmd.on('close', code => {
        const msg = `!closed with status ${code}\n`
        process.stdout.write(`[${id}] ${msg}`)
        for (let ws of logs[id]) {
          ws.send(msg, nop)
          ws.close()
        }
        logs[id] = []

        eventEmitter.removeListener('cancelAll', handleCancelAll)
      })
    }, 200)

    res.write(JSON.stringify({
      success: 'Executing command very soon'
    }))
    res.end()
  })
}

function listen() {
  return new Promise(resolve => {
    server.listen(PORT, () => {
      console.log(`Listening on port ${PORT}!`)
      resolve()
    })
  })
}

function initServer() {
  server.on('request', app)
}

function main() {
  return Promise.all([ loadTasks(), initExpress(), initWSS() ])
    .then(initServer)
    .then(listen)
}

main()
  .catch(e => console.log(e))
