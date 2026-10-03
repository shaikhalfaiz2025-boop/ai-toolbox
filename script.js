// ================================
// AI TOOLBOX - JAVASCRIPT
// ================================

// Tool search
const searchInput = document.getElementById("searchInput");
const toolCards = document.querySelectorAll(".tool-card");

searchInput.addEventListener("input", function () {

    const searchText = searchInput.value.toLowerCase();

    toolCards.forEach(function (card) {

        const toolName = card.querySelector("h3").textContent.toLowerCase();
        const description = card.querySelector("p").textContent.toLowerCase();

        if (
            toolName.includes(searchText) ||
            description.includes(searchText)
        ) {
            card.style.display = "block";
        } else {
            card.style.display = "none";
        }

    });

});


// Try Now buttons
const tryButtons = document.querySelectorAll(".tool-card button");

tryButtons.forEach(function (button) {

    button.addEventListener("click", function () {

        const toolName = button
            .closest(".tool-card")
            .querySelector("h3")
            .textContent;

        alert(
            toolName +
            " is coming soon! 🚀"
        );

    });

});


// Get Started buttons
const startButtons = document.querySelectorAll(".primary-btn");

startButtons.forEach(function (button) {

    button.addEventListener("click", function () {

        document
            .getElementById("tools")
            .scrollIntoView({
                behavior: "smooth"
            });

    });

});


// How It Works button
const howButton = document.querySelector(".secondary-btn");

howButton.addEventListener("click", function () {

    document
        .querySelector(".how-section")
        .scrollIntoView({
            behavior: "smooth"
        });

});