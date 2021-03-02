const {
    app,
    dialog,
    desktopCapturer,
    globalShortcut,
    screen,
    BrowserWindow,
    Menu,
    Tray,
} = require('electron')
const {
    createWorker,
    createScheduler
} = require('tesseract.js')
const sharp = require('sharp')
const robot = require('robotjs')
const path = require('path')

//ocr init
let pool = createScheduler()
let num_workers = 3

/** @type {Array<Tesseract.Worker>} */
let workers = []
for (let i = 0; i < num_workers; i++)
    workers[i] = createWorker()

// Loading window
/** @type {Electron.BrowserWindow} */
let win = null
function createLoadingWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 150,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
    }
  })

  win.loadFile('index.html')
}

function closeLoadingWindow() {
    win.close()
}

let craft_list = []
let num_crafts = 0

function reset_crafts() {
    craft_list = []
    num_crafts = 0
}

reset_crafts()

/**
 * @param {Electron.DesktopCapturerSource} source - The screen source with screenshot in the thumbnail
 */
async function do_generate(source) {
    let { width:w, height:h } = source.thumbnail.getSize()
    let x = Math.round(w * 0.2)
    let width = Math.round(w * 0.425 - x)
    let y = Math.round(h * 0.265)
    let height = Math.round(h * 0.334 - y)
    let step = Math.round(height + h * 0.011)

    let pic = source.thumbnail
    let pics = []

    //get top 5 crafts of the harvest screen
    for(let i = 0; i < Math.min(5, num_crafts); i++) {
        //preprocess for OCR, will look like black text on white paper
        pics[i] = await sharp(pic.crop({x, y:y+step*i, width, height}).toPNG())
                            .negate().threshold(190).toBuffer()
    }

    //wait for each OCR scan
    const ocr_results = await Promise.all(pics.map((pic) => pool.addJob('recognize', pic)));

    //prepare texts and add them to the list
    let texts = ocr_results.map(job => job.data.text.replaceAll('\n', ' ').trim())
    Array.prototype.push.apply(craft_list, texts)
}

/**
 * @param {Electron.DesktopCapturerSource} source - The screen source with screenshot in the thumbnail
 */
async function do_craftnum(source) {
    let { width:w, height:h } = source.thumbnail.getSize()
    let x = Math.round(w * 0.275)
    let width = Math.round(w * 0.3125 - x)
    let y = Math.round(h * 0.215)
    let height = Math.round(h * 0.243 - y)

    pics = [await sharp(source.thumbnail.crop({x, y, width, height}).toPNG())
                    .negate().threshold(190).toBuffer()]

    const ocr_results = await Promise.all(pics.map((pic) => pool.addJob('recognize', pic)));
    num_crafts = +ocr_results[0].data.text.split('/')[0].trim()
} 

async function do_shortcut () {
    reset_crafts()    

    const my_screen = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    let options = { types: ['screen'], thumbnailSize: my_screen.size }
    
    //capture screenshot and add the number of crafts and the crafts
    let old_pos = null
    await desktopCapturer.getSources(options).then(async sources => {
        for (source of sources) {
            if (source.display_id == my_screen.id.toString()) {
                return new Promise(async (resolve, reject) => {
                    // get to top 5 crafts
                    old_pos = robot.getMousePos()
                    let { width, height } = source.thumbnail.getSize()
                    robot.moveMouse(width * 0.3, height * 0.3)
                    robot.scrollMouse(0, 500)
                    await do_craftnum(source)
                    await do_generate(source)
                    resolve()
                })
            }
        }
    })

    if (num_crafts > 5) {
        //capture screenshot for the rest
        await desktopCapturer.getSources(options).then(async sources => {
            for (source of sources) {
                if (source.display_id == my_screen.id.toString()) {
                    return new Promise(async (resolve, reject) => {
                        let { width, height } = source.thumbnail.getSize()
                        robot.moveMouse(width * 0.3, height * 0.3)
                        robot.scrollMouse(0, -500)
                        await do_generate(source)
                        resolve()
                    })
                }
            }
        })

        craft_list.splice(5, 10-num_crafts) //remove duplicate crafts
    }

    if (old_pos != null)
        robot.moveMouse(old_pos.x, old_pos.y)
    
    let craft_window = new BrowserWindow({
        width: 1200,
        height: 600,
        show: false,
        frame: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            enableRemoteModule: true,
        }
    })
    global['craft_list'] = craft_list
    craft_window.setAlwaysOnTop(true, "screen")
    craft_window.loadFile('crafts.html')
}

/**
 * 
 * @param {Electron.KeyboardEvent} event 
 * @param {Electron.BrowserWindow} focusedWindow 
 * @param {Electron.WebContents} focusedWebContents 
 */
function do_howto(event, focusedWindow, focusedWebContents) {
    dialog.showMessageBox({
        type: 'none',
        title: 'Howto',
        message: `Open your craft tab on the left side and hit Ctrl+Alt+C.
                  The mouse pointer will move and scan your crafts. 
                  After the scan, a pop-up window will appear where you can edit the information.
                  Once done with the edits, click Copy Text and paste it into discord`.replaceAll(/\n\s+/g,'\n'),
        icon: path.join(__dirname, 'resources/app.ico'),
    })
}

/**
 * 
 * @param {Electron.KeyboardEvent} event 
 * @param {Electron.BrowserWindow} focusedWindow 
 * @param {Electron.WebContents} focusedWebContents 
 */
function do_about(event, focusedWindow, focusedWebContents) {
    dialog.showMessageBox({
        type: 'none',
        title: 'About',
        message: 'Harvest Crafting generator v' + app.getVersion() + '\nAuthor: Theofilos Mouratidis',
        icon: path.join(__dirname, 'resources/app.ico'),
    })
}

function do_exit() {
    workers.forEach((w) => w.terminate())
    app.quit()
}

let tray = null;
app.whenReady()
.then(() => {
    globalShortcut.register('Alt+CmdOrCtrl+C', do_shortcut)
})
.then(createLoadingWindow)
.then(async () => {
    for (worker of workers) {
        await worker.load()
    }
    for (worker of workers) {
        await worker.loadLanguage('eng')
    }
    for (worker of workers) {
        await worker.initialize('eng')
    }
    for (worker of workers) {
        pool.addWorker(worker)
    }
})
.then(closeLoadingWindow)
.then(() => {
    tray = new Tray(path.join(__dirname, 'resources/app.ico'))
    const ctxMenu = Menu.buildFromTemplate([
        { label: 'How to Use', click: do_howto },
        { label: 'About', click: do_about },
        { label: 'Exit', click: do_exit },
    ])
    tray.setToolTip('Harvest craft generator')
    tray.setContextMenu(ctxMenu)
})

app.on('window-all-closed', () => {})
