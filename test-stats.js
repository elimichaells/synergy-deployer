const fetch = require('node-fetch');

async function test() {
    try {
        const res = await fetch('http://localhost:4000/api/services');
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(err);
    }
}

test();
