async function onPlayersReady() {
    const leader = cards?.Leader?.length > 0 ? cards.Leader[0] : null
    console.log(cards, leader)
    if (leader) {
        const leaderData = functions.getCardData(leader)
        console.log(leaderData)
        await functions.draw(leaderData?.life ?? 0, false, "Life")
    }
}