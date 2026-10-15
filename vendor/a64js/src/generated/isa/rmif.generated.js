export const ENCODINGS = [
    {
        "instructionId": "RMIF",
        "encodingId": "RMIF_only_rmif",
        "mnemonic": "RMIF",
        "className": "Integer",
        "fileName": "rmif.xml",
        "mask": 4292901904,
        "value": 3120563200,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "imm6",
                "lsb": 15,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "o2",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "mask",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_FlagM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FlagM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "rmif"
    }
];
