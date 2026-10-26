async function onPlayersReady() {
    const leader = cards?.Leader?.length > 0 ? cards.Leader[0] : null
    if (leader) {
        const leaderData = functions.getCardData(leader)
        await functions.draw(leaderData?.life ?? 0, false, "Life")
    }
}

async function revealDamage() {
    const damageCards = cards?.Damage
    if (damageCards?.length > 0) {
        await functions.moveCards(damageCards, "Stack")
        await functions.repositionCards()
    }
}

async function drawDamage() {
    const damageCards = cards?.Damage
    if (damageCards?.length > 0) {
        await functions.moveCards(damageCards, "Hand")
        await functions.repositionCards()
    }
}