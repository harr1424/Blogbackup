const puppeteer = require("puppeteer");
const reader = require('@mozilla/readability');
const axios = require("axios");
const { JSDOM } = require("jsdom");
const fs = require('fs');
const prompt = require("prompt-sync")({ sigint: true });
const config = require('./config'); // add your own config file to specify the blog's URL



// URL of blog homepage
const baseURL = config.url;

// Local file to contain JSON data describing posts
const filePath = 'backup.json';

let totalPostsAdded = 0;

// Program entry point
crawl();

async function crawl() {
    try {

        // Read backup.json into memory if it exists 
        backup = loadOrCreateFile();

        const browser = await puppeteer.launch();
        const mainPage = await browser.newPage();
        await mainPage.goto(baseURL, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        let numMainPagesWithNoNewPosts = 0;
        let { nextPage, numNewPostsFound } = await scrapeCurrentlyShownPosts(mainPage);
        let numTimesOlderPostsClicked = 1;

        while (nextPage) {
            console.log(`Older posts has been clicked ${numTimesOlderPostsClicked} times`);

            await mainPage.goto(nextPage, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            ({ nextPage, numNewPostsFound } = await scrapeCurrentlyShownPosts(mainPage));
            numTimesOlderPostsClicked++;

            // If the second main page clicked didn't have new posts, prompt the user to stop scraping
            if (numNewPostsFound === 0) {
                numMainPagesWithNoNewPosts++;
            } else {
                numMainPagesWithNoNewPosts = 0;
            }

            if (numMainPagesWithNoNewPosts > 0) {
                let userChoice = prompt("No new posts have been found lately. Enter 'Q' to stop searching or any key to continue: ");
                if (userChoice === 'Q') {
                    break;
                }
                else {
                    numMainPagesWithNoNewPosts = 0;
                }
            }
        }

        console.log("Releasing browser resources...");
        await mainPage.close();
        await browser.close();
        console.log("Browser resources have been released");
        // Sort array of posts by id (date)
        backup.sort((a, b) => b.id - a.id);

        // Write backup to file 
        writeFile(backup);

    } catch (error) {
        console.error(error);
    }
}

async function scrapeCurrentlyShownPosts(mainPage) {
    try {

        let postsAddedFromMainPage = 0;

        // Find links matching a post href
        const hrefs = await mainPage.$$eval('a', as => as.map(a => a.href));
        const regex = new RegExp(`^https:\/\/${config.url}\\.blogspot\\.com\\/\\d+\\/.*\\.html$`);
        const filteredHrefs = hrefs.filter(url => regex.test(url));


        // For each href corresponding to a post, visit and scrape
        const postPromises = filteredHrefs.map(async (post) => {
            const resp = await axios.get(post);
            const html = resp.data;
            const dom =  new JSDOM(html);
            const document = dom.window.document;

            // Use Readability to access post title and content
            const article = new reader.Readability(document).parse();

            // Create JSON object describing a post
            let postData = new Object();
            const postIdPattern = /\((\d+)\)$/;
            const matches = article.title.match(postIdPattern);

            postData.id = matches ? matches[1] : null;
            postData.title = article.title;

            /* Readability fails to elect the actual content as article content for short posts */

            var postBodyDiv = document.querySelector('.post-body.entry-content');
            if (postBodyDiv) {
                var postBodyContent = postBodyDiv.textContent;
                postData.content = postBodyContent;
            }
            else {
                postData.content = article.textContent;

            }

            postData.URL = post;

            var dateHeader = document.querySelector('.date-header');
            if (dateHeader) {
                var date = dateHeader.textContent;
                postData.date = date;
            }

            /* If object is not a duplicate, append it to the backup
            Here title has been used instead of id as not all posts will have an id */
            const titleExists = backup.some(item => item.title === postData.title);
            if (!titleExists) {
                backup.push(postData);
                postsAddedFromMainPage++;
                totalPostsAdded++;
            }
        });

        await Promise.all(postPromises);
        console.log(`Found ${postsAddedFromMainPage} new posts to backup`);

        // If the main page has an href to older posts, return this href
        const nextPageFound = await mainPage.evaluate(() => {
            const idToFind = "Blog1_blog-pager-older-link";
            const anchorElement = document.getElementById(idToFind);

            if (anchorElement) {
                return anchorElement.getAttribute("href");
            } else {
                return null;
            }
        });

        return { nextPage: nextPageFound, numNewPostsFound: postsAddedFromMainPage };

    } catch (error) {
        console.error(error);
        return null;
    }
}

// If a backup file already exists, load it into memory 
function loadOrCreateFile() {
    // Array to hold JSON objects corresponding to posts 
    let data = [];

    if (fs.existsSync(filePath)) {
        try {
            console.log("Backup file exists. Reading it into memory...")
            const jsonData = fs.readFileSync(filePath, 'utf8');
            data = JSON.parse(jsonData);
            console.log("Backup file loaded.")
        } catch (error) {
            console.error('Error reading or parsing existing JSON backup file:', error);
        }
    } else {
        console.error(`Backup JSON file does not exist, it will be created as ${filePath}`);
    }

    return data;
}

// Write backup array of post objects to file
function writeFile(data) {
    console.log("Writing JSON data to backup file...");
    const jsonData = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, jsonData);
    console.log(`JSON data has been written to ${filePath}`);
    console.log(`Added ${totalPostsAdded} posts to backup.`);
}