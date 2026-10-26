async function onPlayersReady() {
    const leader = cards?.Leader?.length > 0 ? cards.Leader[0] : null
    if (leader) {
        const leaderData = functions.getCardData(leader)
        await functions.draw(leaderData?.life ?? 0, false, "Life")
    }
}