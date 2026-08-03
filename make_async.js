const fs = require('fs');

function makeAsync(file) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace non-async `(req, res) =>` with `async (req, res) =>`
    content = content.replace(/(?<!async\s+)\(req,\s*res\)\s*=>/g, 'async (req, res) =>');
    
    // Replace non-async `(req, res, next) =>` with `async (req, res, next) =>`
    content = content.replace(/(?<!async\s+)\(req,\s*res,\s*next\)\s*=>/g, 'async (req, res, next) =>');

    fs.writeFileSync(file, content);
}

makeAsync('server.js');
makeAsync('auth.js');
console.log('Done');
