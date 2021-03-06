import { IRound } from '../interfaces/IRound';
import { IPlayer } from '../interfaces/IPlayer';
import Deck from './Deck';
import { Action } from './Action';
import { BettingRound, PlayerStatus, ActionType } from '../constants';
import { CardHelpers, IHandWinners, IPlayerCards } from '../utilities/CardHelpers';
import { IAction } from '../interfaces/IAction';
import { EventEmitter } from 'events';
import Logger from '../utilities/Logger';

interface IBlinds {
  sb: number;
  bb: number;
}

interface IParams {
  currentDealer: number;
  players: IPlayer[];
  blinds: IBlinds;
}

/**
 * Round:
 * -  Holds and manages Round state
 * -  Handles actions made by players within a round
 */

export default class Round extends EventEmitter {
  private round: IRound;
  private players: IPlayer[];
  private currentDealer: number;
  private blinds: IBlinds;

  constructor(params: IParams) {
    super();
    this.round = {
      board: [],
      pot: 0,
      highestBet: 0,
      currentPlayer: -1,
      stoppingPoint: -1,
      deck: new Deck(),
      playersFolded: [],
      playersAllIn: [],
      isActive: false,
      winners: {
        ids: [],
        desc: '',
      },
    };
    this.players = params.players;
    this.currentDealer = params.currentDealer;
    this.blinds = params.blinds;
  }

  static determineWinners(players: IPlayer[], board: string[]): IHandWinners {
    const activePlayers = players.filter((player) => {
      return player.isActiveInRound;
    });

    if (activePlayers.length == 1) {
      return { ids: [activePlayers[0].id], desc: '' };
    } else if (activePlayers.length > 1) {
      let playerCards: IPlayerCards[] = [];
      activePlayers.forEach((activePlayer) => {
        playerCards.push({
          id: activePlayer.id,
          cards: activePlayer.pocket.concat(board),
        });
      });
      return CardHelpers.determineWinners(playerCards);
    } else {
      // This should not happen
      return { ids: [], desc: '' };
    }
  }

  start() {
    Logger.log({
      players: this.players.map((player) => ({
        id: player.id,
        pocket: player.pocket.toString(),
      })),
    });
    this.round.isActive = true;
    this.deal();
    this.startNewBettingRound();
    this.postBlinds();
    this.stateUpdated();
  }

  end() {
    Logger.log('ending round');
    this.round.isActive = false;
    this.emit('roundEnded');
  }

  getCurrentPlayer(): IPlayer {
    return this.players[this.round.currentPlayer];
  }

  // Function to increment one step in the round
  increment() {
    // First check if the roubnd is still valid
    if (!this.shouldContinue()) {
      this.finishRound();
    }

    // Stopping point reached
    else if (this.nextPlayer() == this.round.stoppingPoint) {
      setTimeout(() => {
        this.startNewBettingRound();
        this.stateUpdated();
      }, 2000);
    }

    // Check if the next player is a valid player (did not flop or go all in yet)
    else if (
      this.round.playersFolded.includes(this.nextPlayer()) ||
      this.round.playersAllIn.includes(this.nextPlayer())
    ) {
      // recursion ;)
      this.increment();
    }

    // Still a valid round
    else {
      Logger.log('going to next player');
      this.round.currentPlayer = this.nextPlayer();
    }

    this.stateUpdated();
  }

  performAction(action: IAction): boolean {
    return new Action({
      player: this.getCurrentPlayer(),
      action,
      round: this.round,
    }).performAction();
  }

  getRound(): IRound {
    return this.round;
  }

  getBlinds(): IBlinds {
    return this.blinds;
  }

  private stateUpdated(): void {
    this.emit('stateUpdated');
  }
  // Deals two cards to each player
  private deal(): void {
    this.players.map((player) => (player.pocket = []));
    for (let i = 0; i < 2; i++) {
      this.players.map((player) => player.pocket.push(this.round.deck.draw()));
    }
  }

  /**
   * -  Draws cards from the top of the deck to the board
   * -  Burns top card before drawing any cards
   * -  Draws 3 cards for the flop, and 1 card for the turn and the river
   */
  private draw(): void {
    const board = this.round.board;
    this.round.deck.draw(); // burn top card
    if (board.length == 0) {
      for (let i = 0; i < 3; i++) {
        board.push(this.round.deck.draw());
      }
    } else {
      board.push(this.round.deck.draw());
    }
  }

  // Post blinds for small blind and big blind players
  private postBlinds(): void {
    let sbPlayer = this.players.find((player) => player.id === this.getSB());
    let bbPlayer = this.players.find((player) => player.id === this.getBB());
    if (sbPlayer === undefined || bbPlayer === undefined) {
      throw new Error(
        'Error posting blinds to small blind id: ' +
          this.getSB() +
          ' and big blind id: ' +
          this.getBB()
      );
    }

    new Action({
      player: sbPlayer,
      action: {
        actionType: ActionType.blind,
        betAmount: this.blinds.sb,
      },
      round: this.round,
    }).performAction();

    new Action({
      player: bbPlayer,
      action: {
        actionType: ActionType.blind,
        betAmount: this.blinds.bb,
      },
      round: this.round,
    }).performAction();
  }

  // Determine winners, carry out payouts, and end the round
  private finishRound() {
    const winners = Round.determineWinners(this.players, this.round.board);
    this.round.winners = winners;
    this.payout(winners);
    this.stateUpdated();

    // Delay to show winner before moving on to the next round
    setTimeout(() => {
      this.end();
    }, 3000);

    Logger.log({
      board: this.round.board,
      players: this.players.map((player) => ({
        id: player.id,
        pocket: player.pocket.toString(),
      })),
      winners,
    });
  }

  // Pre-flop, flop, turn, river
  private startNewBettingRound() {
    this.resetPlayers();
    const didIncrement = this.incrementBettingRound();
    if (didIncrement) {
      Logger.log(`starting new betting round: ${this.round.bettingRound}`);
      this.round.highestBet = 0;
      const firstToBet =
        this.round.bettingRound == BettingRound.preFlop ? this.getUTG() : this.getSB();
      this.round.currentPlayer = firstToBet;
      this.round.stoppingPoint = firstToBet;

      Logger.log(`current player is ${this.round.currentPlayer}`);
      if (this.round.bettingRound !== BettingRound.preFlop) {
        this.draw();
      }
    } else {
      this.finishRound();
    }
  }

  private resetPlayers() {
    this.players.map((player) => {
      player.status = PlayerStatus.default;
      player.currentBet = 0;
      player.isActiveInRound = true;
    });
  }

  // Set betting round to the next stage. Function returns false if betting round is currently the river, true otherwise
  private incrementBettingRound(): boolean {
    switch (this.round.bettingRound) {
      case BettingRound.preFlop:
        this.round.bettingRound = BettingRound.flop;
        return true;
      case BettingRound.flop:
        this.round.bettingRound = BettingRound.turn;
        return true;
      case BettingRound.turn:
        this.round.bettingRound = BettingRound.river;
        return true;
      case BettingRound.river:
        return false;
      default:
        this.round.bettingRound = BettingRound.preFlop;
        return true;
    }
  }

  // Sets current player to the next player
  private nextPlayer(): number {
    return (this.round.currentPlayer + 1) % this.players.length;
  }

  private payout(winners: IHandWinners): void {
    const winningPlayerIds = winners.ids;
    const potDivided = (1.0 * this.round.pot) / winningPlayerIds.length;
    winningPlayerIds.map((id) => {
      this.players[id].chipCount += potDivided;
    });
  }

  // Gets the Small Blind player id
  private getSB(): number {
    return (this.currentDealer + 1) % this.players.length;
  }

  // Gets the Big Blind player id
  private getBB(): number {
    return (this.currentDealer + 2) % this.players.length;
  }

  // Gets the Under the Gun player id
  private getUTG(): number {
    return (this.currentDealer + 3) % this.players.length;
  }

  // This function returns true if there are more than 2 players in play and at least one of them is not all in
  private shouldContinue(): boolean {
    const playersInPlay = this.players.length - this.round.playersFolded.length;
    return playersInPlay > 1 && playersInPlay > this.round.playersAllIn.length;
  }
}
